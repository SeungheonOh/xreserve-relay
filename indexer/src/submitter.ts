import { ethers } from "ethers";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import {
  ROUTER_ABI,
  RELAYED_TOPIC0,
  FALLBACK_TRIGGERED_TOPIC0,
  RECOVERED_FROM_CONSUMED_NONCE_TOPIC0,
  OPERATOR_ROUTED_TOPIC0,
} from "./abis.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startSubmitter(config: Config, store: Store): void {
  const provider = new ethers.JsonRpcProvider(config.ethereumRpcUrl);
  const wallet = new ethers.Wallet(config.relayerPrivateKey, provider);
  const router = new ethers.Contract(config.routerAddress, ROUTER_ABI, wallet);

  async function loop(): Promise<void> {
    while (true) {
      try {
        const job = store.getOldestByStatus("attested");

        if (!job) {
          await sleep(config.submitterPollIntervalMs);
          continue;
        }

        try {
          // Estimate gas first to catch reverts cheaply
          let gasEstimate: bigint;
          try {
            gasEstimate = await router.receiveAndForward.estimateGas(
              job.attestedMessage,
              job.attestation,
              config.relayFee,
            );
          } catch (err) {
            throw new Error(
              `Gas estimation failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          // Submit with 20% gas buffer
          const tx = await router.receiveAndForward(
            job.attestedMessage,
            job.attestation,
            config.relayFee,
            { gasLimit: (gasEstimate * 120n) / 100n },
          );

          store.updateJob(job.txHash, {
            ethTxHash: tx.hash,
            status: "submitted",
            submittedAt: new Date().toISOString(),
          });

          console.log(`Submitted tx ${tx.hash} for ${job.txHash}`);

          // Wait for 1 confirmation
          const receipt = await tx.wait(1);

          if (!receipt || receipt.status === 0) {
            throw new Error(`Tx reverted: ${tx.hash}`);
          }

          // Determine outcome from events
          let outcome: "forwarded" | "fallback" | "operator_routed" | null =
            null;

          const relayedLog = receipt.logs.find(
            (log: ethers.Log) => log.topics[0] === RELAYED_TOPIC0,
          );
          const fallbackLog = receipt.logs.find(
            (log: ethers.Log) =>
              log.topics[0] === FALLBACK_TRIGGERED_TOPIC0,
          );
          const operatorRoutedLog = receipt.logs.find(
            (log: ethers.Log) =>
              log.topics[0] === OPERATOR_ROUTED_TOPIC0,
          );
          const recoveredLog = receipt.logs.find(
            (log: ethers.Log) =>
              log.topics[0] === RECOVERED_FROM_CONSUMED_NONCE_TOPIC0,
          );

          if (relayedLog) {
            outcome = "forwarded";
          } else if (fallbackLog) {
            outcome = "fallback";
          } else if (operatorRoutedLog) {
            outcome = "operator_routed";
            console.warn(
              `Operator-routed for ${job.txHash} (empty or malformed hookData)`,
            );
          }

          // Log if the nonce-consumed recovery path was used
          if (recoveredLog) {
            console.warn(
              `Nonce-consumed recovery used for ${job.txHash}`,
            );
          }

          store.updateJob(job.txHash, {
            ethBlockNumber: receipt.blockNumber,
            confirmedAt: new Date().toISOString(),
            outcome,
            status: "confirmed",
          });

          console.log(
            `Relay confirmed: ${job.txHash} → ${outcome ?? "unknown"}`,
          );
        } catch (err) {
          const message =
            err instanceof Error ? err.message : String(err);
          console.error(`Submission failed for ${job.txHash}:`, message);

          // "transfer settled" means the replay guard fired — this
          // transfer was already processed. No point retrying.
          const terminal =
            message.includes("transfer settled") ||
            message.includes("Nonce already used") ||
            message.includes("invalid destinationDomain") ||
            message.includes("invalid destinationCaller") ||
            message.includes("invalid mintRecipient");

          if (terminal) {
            store.updateJob(job.txHash, {
              status: "failed",
              error: message,
              retryCount: job.retryCount + 1,
            });
          } else {
            const newRetryCount = job.retryCount + 1;
            if (newRetryCount >= config.maxRetries) {
              store.updateJob(job.txHash, {
                status: "failed",
                error: message,
                retryCount: newRetryCount,
              });
            } else {
              // Keep as attested for retry
              store.updateJob(job.txHash, {
                error: message,
                retryCount: newRetryCount,
              });
            }
          }
        }
      } catch (err) {
        console.error("Submitter loop error:", err);
      }

      await sleep(1000);
    }
  }

  loop().catch((err) => {
    console.error("Submitter fatal error:", err);
    process.exit(1);
  });
}
