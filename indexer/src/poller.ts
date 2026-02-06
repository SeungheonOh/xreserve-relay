import { ethers } from "ethers";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { irisRateLimiter } from "./ratelimit.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AttestationResult {
  message: string;
  attestation: string;
  nonce: string;
}

interface Validation {
  valid: boolean;
  reason?: string;
  mintRecipient?: string;
  destinationDomain?: number;
  amount?: string;
}

const BYTES32_ZERO =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

function validateAttestedMessage(
  messageHex: string,
  routerAddress: string,
  routerBytes32: string,
): Validation {
  const message = ethers.getBytes(messageHex);

  // MessageV2 header (148 bytes) + BurnMessageV2 body must be long enough
  // to include at least through the amount field (header 148 + 100 bytes body = 248)
  if (message.length < 248) {
    return { valid: false, reason: "message too short" };
  }

  // Destination domain at header offset 8 (uint32, big-endian)
  const destinationDomain = new DataView(
    message.buffer,
    message.byteOffset + 8,
    4,
  ).getUint32(0);
  if (destinationDomain !== 0) {
    return {
      valid: false,
      reason: `destination domain ${destinationDomain} != 0 (Ethereum)`,
    };
  }

  // destinationCaller at header offset 108 (bytes32)
  // Patch 8: production burns should set destinationCaller = router.
  // Open caller (zero) is accepted but logged as a warning — a third
  // party could front-run receiveMessage and consume the nonce.
  const destinationCaller = ethers.hexlify(message.slice(108, 140));
  if (
    destinationCaller !== BYTES32_ZERO &&
    destinationCaller.toLowerCase() !== routerBytes32.toLowerCase()
  ) {
    return {
      valid: false,
      reason: `destinationCaller ${destinationCaller} != router or zero`,
    };
  }
  if (destinationCaller === BYTES32_ZERO) {
    console.warn(
      "destinationCaller is zero (open) — nonce front-run risk",
    );
  }

  // mintRecipient: BurnMessageV2 body offset 36 (bytes32), absolute offset 184
  const mintRecipientBytes32 = ethers.hexlify(message.slice(184, 216));
  const mintRecipient = ethers.getAddress("0x" + mintRecipientBytes32.slice(-40));

  if (mintRecipient.toLowerCase() !== routerAddress.toLowerCase()) {
    return {
      valid: false,
      reason: `mintRecipient ${mintRecipient} != router ${routerAddress}`,
    };
  }

  // Amount: BurnMessageV2 body offset 68 (uint256), absolute offset 216
  const amount = ethers.toBigInt(message.slice(216, 248)).toString();

  return { valid: true, mintRecipient, destinationDomain, amount };
}

async function pollForAttestation(
  config: Config,
  sourceDomain: number,
  txHash: string,
): Promise<AttestationResult | null> {
  const url = `${config.irisApiBaseUrl}/v2/messages/${sourceDomain}?transactionHash=${txHash}`;

  await irisRateLimiter.acquire();
  const response = await fetch(url);

  if (response.status === 404) {
    return null; // Not yet indexed
  }

  if (response.status === 429) {
    throw new Error("RATE_LIMITED");
  }

  if (!response.ok) {
    console.error(`Iris API error: ${response.status}`);
    return null;
  }

  const data = (await response.json()) as {
    messages?: {
      message: string;
      attestation: string;
      eventNonce: string;
      status: string;
    }[];
  };

  if (!data.messages || data.messages.length === 0) {
    return null;
  }

  const msg = data.messages[0];

  if (msg.status === "complete" && msg.attestation !== "PENDING") {
    return {
      message: msg.message,
      attestation: msg.attestation,
      nonce: msg.eventNonce,
    };
  }

  return null; // Still pending
}

export function startPoller(config: Config, store: Store): void {
  async function loop(): Promise<void> {
    while (true) {
      try {
        const jobs = store.getJobsByStatus(["pending", "polling"], 20);

        for (const job of jobs) {
          // Check attestation timeout
          const elapsed =
            Date.now() - new Date(job.createdAt).getTime();
          if (elapsed > config.attestationTimeoutMs) {
            store.updateJob(job.txHash, {
              status: "failed",
              error: "attestation_timeout",
            });
            continue;
          }

          // Move pending → polling
          if (job.status === "pending") {
            store.updateJob(job.txHash, { status: "polling" });
          }

          try {
            const result = await pollForAttestation(
              config,
              job.sourceDomain,
              job.txHash,
            );

            if (result) {
              const validation = validateAttestedMessage(
                result.message,
                config.routerAddress,
                config.routerBytes32,
              );

              if (!validation.valid) {
                store.updateJob(job.txHash, {
                  status: "failed",
                  error: validation.reason ?? "invalid message",
                });
                continue;
              }

              store.updateJob(job.txHash, {
                status: "attested",
                attestedMessage: result.message,
                attestation: result.attestation,
                irisNonce: result.nonce,
                mintRecipient: validation.mintRecipient ?? null,
                destinationDomain: validation.destinationDomain ?? null,
                amount: validation.amount ?? null,
                attestedAt: new Date().toISOString(),
                pollAttempts: job.pollAttempts + 1,
              });

              console.log(
                `Attestation received for ${job.txHash} (domain ${job.sourceDomain})`,
              );
            } else {
              store.updateJob(job.txHash, {
                pollAttempts: job.pollAttempts + 1,
              });
            }
          } catch (err) {
            if (err instanceof Error && err.message === "RATE_LIMITED") {
              console.warn(
                "Rate limited by Circle API, backing off 60s",
              );
              await sleep(60_000);
              break; // Exit inner loop
            }
            console.error(`Poller error for ${job.txHash}:`, err);
          }
        }
      } catch (err) {
        console.error("Poller loop error:", err);
      }

      await sleep(config.pollCycleIntervalMs);
    }
  }

  loop().catch((err) => {
    console.error("Poller fatal error:", err);
    process.exit(1);
  });
}
