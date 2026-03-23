import { filterToolsByPolicy } from "./pi-tools.policy.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { isKnownCoreToolId } from "./tool-catalog.js";
import {
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  stripPluginOnlyAllowlist,
  type ToolPolicyLike,
} from "./tool-policy.js";

export type ToolPolicyPipelineStep = {
  policy: ToolPolicyLike | undefined;
  label: string;
  stripPluginOnlyAllowlist?: boolean;
};

export function buildDefaultToolPolicyPipelineSteps(params: {
  profilePolicy?: ToolPolicyLike;
  profile?: string;
  providerProfilePolicy?: ToolPolicyLike;
  providerProfile?: string;
  globalPolicy?: ToolPolicyLike;
  globalProviderPolicy?: ToolPolicyLike;
  agentPolicy?: ToolPolicyLike;
  agentProviderPolicy?: ToolPolicyLike;
  groupPolicy?: ToolPolicyLike;
  agentId?: string;
}): ToolPolicyPipelineStep[] {
  const agentId = params.agentId?.trim();
  const profile = params.profile?.trim();
  const providerProfile = params.providerProfile?.trim();
  return [
    {
      policy: params.profilePolicy,
      label: profile ? `tools.profile (${profile})` : "tools.profile",
      stripPluginOnlyAllowlist: true,
    },
    {
      policy: params.providerProfilePolicy,
      label: providerProfile
        ? `tools.byProvider.profile (${providerProfile})`
        : "tools.byProvider.profile",
      stripPluginOnlyAllowlist: true,
    },
    { policy: params.globalPolicy, label: "tools.allow", stripPluginOnlyAllowlist: true },
    {
      policy: params.globalProviderPolicy,
      label: "tools.byProvider.allow",
      stripPluginOnlyAllowlist: true,
    },
    {
      policy: params.agentPolicy,
      label: agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
      stripPluginOnlyAllowlist: true,
    },
    {
      policy: params.agentProviderPolicy,
      label: agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
      stripPluginOnlyAllowlist: true,
    },
    { policy: params.groupPolicy, label: "group tools.allow", stripPluginOnlyAllowlist: true },
  ];
}

/**
 * Process-wide dedup set for tool policy warnings.
 *
 * The `applyToolPolicyPipeline` function is called on every tool invocation for every
 * active agent session. When a tools.profile allowlist references core tool IDs that are
 * unavailable in the current runtime (e.g. "read", "write", "edit" in a non-coding
 * context), the warning fires synchronously on each call. With many concurrent agent
 * sessions this produces thousands of redundant log lines per minute, flooding the
 * Node.js event loop and starving the gateway WebSocket server's connection-upgrade
 * handler — resulting in "closed before connect" (code 1006) and "gateway timeout"
 * errors on `sessions_send` / `callGateway` calls.
 *
 * Fix: deduplicate identical warnings within the process lifetime. Each unique
 * (label + entries) combination is only warned once. This matches the user-visible
 * behaviour that matters (warn once that the config has unknown entries) while
 * eliminating the synchronous per-call hot path.
 */
const _warnedMessages = new Set<string>();

export function applyToolPolicyPipeline(params: {
  tools: AnyAgentTool[];
  toolMeta: (tool: AnyAgentTool) => { pluginId: string } | undefined;
  warn: (message: string) => void;
  steps: ToolPolicyPipelineStep[];
}): AnyAgentTool[] {
  const coreToolNames = new Set(
    params.tools
      .filter((tool) => !params.toolMeta(tool))
      .map((tool) => normalizeToolName(tool.name))
      .filter(Boolean),
  );

  const pluginGroups = buildPluginToolGroups({
    tools: params.tools,
    toolMeta: params.toolMeta,
  });

  let filtered = params.tools;
  for (const step of params.steps) {
    if (!step.policy) {
      continue;
    }

    let policy: ToolPolicyLike | undefined = step.policy;
    if (step.stripPluginOnlyAllowlist) {
      const resolved = stripPluginOnlyAllowlist(policy, pluginGroups, coreToolNames);
      if (resolved.unknownAllowlist.length > 0) {
        const entries = resolved.unknownAllowlist.join(", ");
        const gatedCoreEntries = resolved.unknownAllowlist.filter((entry) =>
          isKnownCoreToolId(entry),
        );
        const otherEntries = resolved.unknownAllowlist.filter((entry) => !isKnownCoreToolId(entry));
        const suffix = describeUnknownAllowlistSuffix({
          strippedAllowlist: resolved.strippedAllowlist,
          hasGatedCoreEntries: gatedCoreEntries.length > 0,
          hasOtherEntries: otherEntries.length > 0,
        });
        const message = `tools: ${step.label} allowlist contains unknown entries (${entries}). ${suffix}`;
        // Deduplicate: only warn once per unique message per process lifetime.
        // Repeated identical warnings on every tool call flood the event loop and
        // degrade gateway WebSocket connection handling under multi-agent load.
        // See: https://github.com/openclaw/openclaw/issues (gateway-stability fix)
        if (!_warnedMessages.has(message)) {
          _warnedMessages.add(message);
          params.warn(message);
        }
      }
      policy = resolved.policy;
    }

    const expanded = expandPolicyWithPluginGroups(policy, pluginGroups);
    filtered = expanded ? filterToolsByPolicy(filtered, expanded) : filtered;
  }
  return filtered;
}

/**
 * Reset the warning dedup set. Intended for use in tests only.
 * @internal
 */
export function __resetWarnedMessagesForTest(): void {
  _warnedMessages.clear();
}

function describeUnknownAllowlistSuffix(params: {
  strippedAllowlist: boolean;
  hasGatedCoreEntries: boolean;
  hasOtherEntries: boolean;
}): string {
  const preface = params.strippedAllowlist
    ? "Ignoring allowlist so core tools remain available."
    : "";
  const detail =
    params.hasGatedCoreEntries && params.hasOtherEntries
      ? "Some entries are shipped core tools but unavailable in the current runtime/provider/model/config; other entries won't match any tool unless the plugin is enabled."
      : params.hasGatedCoreEntries
        ? "These entries are shipped core tools but unavailable in the current runtime/provider/model/config."
        : "These entries won't match any tool unless the plugin is enabled.";
  return preface ? `${preface} ${detail}` : detail;
}
