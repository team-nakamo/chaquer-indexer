#!/usr/bin/env node
import "dotenv/config";
import { z } from "zod";
import { DefaultLogger, eq } from "drizzle-orm";
import { createPublicClient, fallback, webSocket, http, Transport } from "viem";
import fastify from "fastify";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { AppRouter, createAppRouter } from "@latticexyz/store-sync/trpc-indexer";
import { createQueryAdapter } from "../src/postgres/createQueryAdapter";
import { isDefined } from "@latticexyz/common/utils";
import { combineLatest, filter, first } from "rxjs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cleanDatabase, postgresStorage, schemaVersion } from "@latticexyz/store-sync/postgres";
import { createStoreSync } from "@latticexyz/store-sync";
import { parseEnv } from "./parseEnv";

const env = parseEnv(
  z.object({
    DATABASE_URL: z.string(),
  })
);

const transports: Transport[] = [
  // prefer WS when specified
  env.RPC_WS_URL ? webSocket(env.RPC_WS_URL) : undefined,
  // otherwise use or fallback to HTTP
  env.RPC_HTTP_URL ? http(env.RPC_HTTP_URL) : undefined,
].filter(isDefined);

const publicClient = createPublicClient({
  transport: fallback(transports),
  pollingInterval: env.POLLING_INTERVAL,
});

const chainId = await publicClient.getChainId();
const database = drizzle(postgres(env.DATABASE_URL), {
  logger: new DefaultLogger(),
});

const { storageAdapter, internalTables } = await postgresStorage({ database, publicClient });

let startBlock = env.START_BLOCK;

// Resume from latest block stored in DB. This will throw if the DB doesn't exist yet, so we wrap in a try/catch and ignore the error.
try {
  const currentChainStates = await database
    .select()
    .from(internalTables.chain)
    .where(eq(internalTables.chain.chainId, chainId))
    .execute();
  // TODO: replace this type workaround with `noUncheckedIndexedAccess: true` when we can fix all the issues related (https://github.com/latticexyz/mud/issues/1212)
  const currentChainState: (typeof currentChainStates)[number] | undefined = currentChainStates[0];

  if (currentChainState != null) {
    if (currentChainState.schemaVersion != schemaVersion) {
      console.log(
        "schema version changed from",
        currentChainState.schemaVersion,
        "to",
        schemaVersion,
        "cleaning database"
      );
      await cleanDatabase(database);
    } else if (currentChainState.lastUpdatedBlockNumber != null) {
      console.log("resuming from block number", currentChainState.lastUpdatedBlockNumber + 1n);
      startBlock = currentChainState.lastUpdatedBlockNumber + 1n;
    }
  }
} catch (error) {
  // ignore errors, this is optional
}

const { latestBlockNumber$, storedBlockLogs$ } = await createStoreSync({
  storageAdapter,
  publicClient,
  startBlock,
  maxBlockRange: env.MAX_BLOCK_RANGE,
});

storedBlockLogs$.subscribe();

let isCaughtUp = false;
combineLatest([latestBlockNumber$, storedBlockLogs$])
  .pipe(
    filter(
      ([latestBlockNumber, { blockNumber: lastBlockNumberProcessed }]) => latestBlockNumber === lastBlockNumberProcessed
    ),
    first()
  )
  .subscribe(() => {
    isCaughtUp = true;
    console.log("all caught up");
  });

// @see https://fastify.dev/docs/latest/
const server = fastify({
  maxParamLength: 5000,
});

await server.register(import("@fastify/cors"));

// k8s healthchecks
server.get("/healthz", (req, res) => res.code(200).send());
server.get("/readyz", (req, res) => (isCaughtUp ? res.code(200).send("ready") : res.code(424).send("backfilling")));

// @see https://trpc.io/docs/server/adapters/fastify
server.register(fastifyTRPCPlugin<AppRouter>, {
  prefix: "/trpc",
  trpcOptions: {
    router: createAppRouter(),
    createContext: async () => ({
      queryAdapter: await createQueryAdapter(database),
    }),
  },
});

await server.listen({ host: env.HOST, port: env.PORT });
console.log(`indexer server listening on http://${env.HOST}:${env.PORT}`);
