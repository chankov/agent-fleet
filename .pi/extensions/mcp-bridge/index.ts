import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";

export interface McpBridgeConfig {
	prefix: string;
	command: string;
	args: string[];
	clientName?: string;
	labelPrefix?: string;
	statusCommandName?: string;
}

type JsonObject = Record<string, unknown>;

function humanizePrefix(prefix: string): string {
	return prefix
		.replace(/__+$/, "")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.trim();
}

function toPiToolName(prefix: string, mcpToolName: string): string {
	const safeName = mcpToolName.replace(/[^A-Za-z0-9_-]/g, "_");
	return `${prefix}${safeName}`;
}

function normalizeInputSchema(tool: Tool) {
	const schema = tool.inputSchema as JsonObject | undefined;
	if (!schema || typeof schema !== "object") {
		return Type.Object({});
	}

	return {
		type: "object",
		properties: {},
		additionalProperties: true,
		...schema,
	} as ReturnType<typeof Type.Object>;
}

function stringifyMcpContent(content: unknown): string {
	if (!Array.isArray(content)) {
		return JSON.stringify(content, null, 2);
	}

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return String(part);
			const item = part as JsonObject;

			if (item.type === "text" && typeof item.text === "string") {
				return item.text;
			}

			if (item.type === "image") {
				const mimeType = typeof item.mimeType === "string" ? item.mimeType : "image/*";
				return `[Image returned by MCP bridge: ${mimeType}]`;
			}

			if (item.type === "resource") {
				return `[Resource returned by MCP bridge]\n${JSON.stringify(item.resource ?? item, null, 2)}`;
			}

			return JSON.stringify(item, null, 2);
		})
		.join("\n\n");
}

export function createMcpBridgeExtension(config: McpBridgeConfig) {
	const {
		prefix,
		command,
		args,
		clientName = `pi-${prefix.replace(/__+$/, "")}`,
		labelPrefix = humanizePrefix(prefix),
		statusCommandName = `${prefix.replace(/__+$/, "")}-status`,
	} = config;

	async function connect() {
		const client = new Client({ name: clientName, version: "1.0.0" });
		const transport = new StdioClientTransport({ command, args });
		await client.connect(transport);
		return { client, transport };
	}

	return async function mcpBridgeExtension(pi: ExtensionAPI) {
		let client: Client | undefined;
		let transport: StdioClientTransport | undefined;
		let tools: Tool[] = [];

		try {
			const connection = await connect();
			client = connection.client;
			transport = connection.transport;
			tools = (await client.listTools()).tools ?? [];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			pi.registerCommand(statusCommandName, {
				description: `Show ${labelPrefix} MCP bridge status`,
				handler: async (_args, ctx) => {
					ctx.ui.notify(`${labelPrefix} MCP failed to start: ${message}`, "error");
				},
			});
			return;
		}

		for (const tool of tools) {
			const piToolName = toPiToolName(prefix, tool.name);

			pi.registerTool({
				name: piToolName,
				label: `${labelPrefix}: ${tool.name}`,
				description: `${tool.description ?? `${labelPrefix} MCP tool`}\n\nWrapped MCP tool: ${tool.name}`,
				promptSnippet: `${piToolName}: use ${labelPrefix} MCP tool '${tool.name}'.`,
				parameters: normalizeInputSchema(tool),
				executionMode: "sequential",
				execute: async (_toolCallId, params, signal) => {
					if (!client) {
						throw new Error(`${labelPrefix} MCP client is not connected`);
					}
					if (signal?.aborted) {
						throw new Error(`${labelPrefix} MCP tool call was aborted before it started`);
					}

					const result = await client.callTool({
						name: tool.name,
						arguments: params as JsonObject,
					});

					if (result.isError) {
						throw new Error(stringifyMcpContent(result.content));
					}

					return {
						content: [{ type: "text", text: stringifyMcpContent(result.content) }],
						details: { mcpToolName: tool.name, rawResult: result },
					};
				},
			});
		}

		pi.registerCommand(statusCommandName, {
			description: `Show ${labelPrefix} MCP bridge status`,
			handler: async (_args, ctx) => {
				ctx.ui.notify(`${labelPrefix} MCP connected. Registered ${tools.length} tool(s).`, "success");
			},
		});

		pi.on("session_shutdown", async () => {
			await client?.close().catch(() => undefined);
			await transport?.close?.().catch(() => undefined);
			client = undefined;
			transport = undefined;
		});
	};
}
