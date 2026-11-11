import { loadSystem1Snapshot, providerDocument, readSystem1Selected } from "./config-loader.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { JevTransport } from "./jev.ts";
import { createSystem1Runtime } from "./service.ts";

const SYNTHETIC_REQUEST = {
  state: {
    bg: "Синтетичен сигнал: заявката има двусмислена промяна и изисква преглед.",
    en: "Synthetic signal: the request has an ambiguous change and needs review.",
  },
  questionSetVersion: "system1-demo-v1",
  requiredCapabilities: ["distribution"] as const,
  questions: [
    {
      id: "route",
      type: "choice" as const,
      instructions: "Избери маршрут / Choose a route",
      options: { accept: "Приеми / Accept", review: "Преглед / Review" },
    },
    {
      id: "urgent",
      type: "predicate" as const,
      instructions: "Спешно ли е? / Is it urgent?",
    },
    {
      id: "severity",
      type: "ordinal" as const,
      instructions: "Оцени тежестта / Rate severity",
      levels: ["low", "medium", "high"],
    },
  ],
};

function workspaceInputs(cwd: string): { selected: boolean; config: unknown } {
 return { selected: readSystem1Selected(cwd), config: providerDocument(loadSystem1Snapshot(cwd)) };
}

export interface RunSystem1DemoOptions {
  argv?: readonly string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  transport?: JevTransport;
  write?: (line: string) => void;
}

export async function runSystem1Demo(options: RunSystem1DemoOptions = {}) {
  const argv = options.argv ?? [];
  if (argv.some((arg) => arg !== "--live") || argv.filter((arg) => arg === "--live").length > 1) {
    throw new Error("usage: demo.ts [--live]");
  }
  const live = argv.includes("--live");
  const { selected, config } = workspaceInputs(resolve(options.cwd ?? process.cwd()));
  const runtime = createSystem1Runtime({ selected, config, env: options.env ?? process.env, transport: options.transport });
  const write = options.write ?? console.log;

  if (!live) {
    const report = runtime.readiness.status === "ready"
      ? { mode: "offline" as const, status: "ready" as const }
      : { mode: "offline" as const, ...runtime.readiness };
    write(JSON.stringify(report, null, 2));
    return report;
  }

  const result = await runtime.service.evaluate(SYNTHETIC_REQUEST);
  if (result.status !== "ok") {
    const report = { mode: "live" as const, ...result };
    write(JSON.stringify(report, null, 2));
    return report;
  }
  const evaluation = result.evaluation;
  const report = {
    mode: "live" as const,
    status: "ok" as const,
    model: evaluation.metadata.returnedModel,
    uncertainty: evaluation.answers.map((answer) => ({
      questionId: answer.questionId,
      ...(answer.type === "predicate" ? { probabilityTrue: answer.probabilityTrue } : {}),
      ...answer.uncertainty,
    })),
    latencyMs: evaluation.metadata.latencyMs,
    usage: evaluation.metadata.usage ?? null,
  };
  write(JSON.stringify(report, null, 2));
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runSystem1Demo({ argv: process.argv.slice(2) }).catch(() => {
    console.error("System 1 demo failed before producing a structured result.");
    process.exitCode = 1;
  });
}
