// Spike-catcher bot for the pump.fun replay (agent-fun/replay/v2).
// The strategy lives in strategy.ts; the SDK shim is vendored byte for byte
// in vendor/ (a copy of the kit's sdk/ts/makefun-bot.ts).
//
// Run by the grader as `node /bot/main.ts` with this directory mounted at
// /bot (Node 22.18+ runs the TypeScript as it is; no build, no install).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
