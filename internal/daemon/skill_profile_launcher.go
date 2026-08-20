package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"remote-agent/internal/protocol"
)

// Custom agent launcher: translates a CustomAgent definition (base CLI +
// skill set) into agent-specific launch modifications (CLI args + env).
// One function per agent keeps the rules isolated; unsupported agents return
// errUnsupportedSkillAgent.

// Base CLIs that support custom agents (docs/skill-profiles-plan.md §2):
// pi, kimi, opencode, claude, codex, kilo. Qwen/Gemini are intentionally
// excluded (append-only or no custom skill paths).
var skillProfileSupportedAgents = map[string]bool{
	"pi":       true,
	"kimi":     true,
	"opencode": true,
	"claude":   true,
	"codex":    true,
	"kilo":     true,
}

var errUnsupportedSkillAgent = fmt.Errorf("agent does not support custom agents")

type skillLaunchPlan struct {
	Args     []string
	Env      []string
	Warnings []string
}

// resolveAgentSkillPaths expands every skill ref in the definition to an
// existing absolute path under an allowed root.
func resolveAgentSkillPaths(agent protocol.CustomAgent) ([]string, error) {
	paths := make([]string, 0, len(agent.Skills))
	for _, ref := range agent.Skills {
		candidate := expandHomePath(ref.Path)
		if candidate == "" {
			dir, _, err := findSkill(ref.Name)
			if err != nil {
				return nil, fmt.Errorf("skill %q: %w", ref.Name, err)
			}
			candidate = dir
		}
		if !withinAllowedRoots(candidate) {
			return nil, fmt.Errorf("skill %q resolves outside allowed roots", ref.Name)
		}
		if _, err := os.Stat(filepath.Join(candidate, skillFileName)); err != nil {
			return nil, fmt.Errorf("skill %q has no SKILL.md", ref.Name)
		}
		paths = append(paths, candidate)
	}
	return paths, nil
}

// baseAgentCommand returns the launch command for a base CLI.
func baseAgentCommand(base string) string {
	switch base {
	case "claude":
		return "claude"
	case "kilocode":
		return "kilo"
	default:
		return base // pi, kimi, opencode, codex, kilo all launch by their name
	}
}

// buildSkillLaunchPlan computes base-CLI-specific args/env for an agent.
// base must already be normalized (normalizeAgentName).
func buildSkillLaunchPlan(base string, agent protocol.CustomAgent) (*skillLaunchPlan, error) {
	if !skillProfileSupportedAgents[base] {
		return nil, errUnsupportedSkillAgent
	}
	// A custom agent is a full launch context: skills, prompt, extra env. Any of
	// those present means we must translate — and for discovery-based CLIs the
	// whitelist must apply even with zero selected skills ("--no-skills and
	// nothing else" is a valid, isolation-first configuration).
	if len(agent.Skills) == 0 && len(agent.ExtraEnv) == 0 && strings.TrimSpace(agent.SystemPrompt) == "" {
		// Nothing to inject; keep stock behavior.
		return &skillLaunchPlan{}, nil
	}
	skillPaths, err := resolveAgentSkillPaths(agent)
	if err != nil {
		return nil, err
	}
	plan := &skillLaunchPlan{}
	switch base {
	case "pi":
		// Whitelist: disable discovery, pass explicit --skill paths.
		// Applies even with an empty skill list: a custom pi agent must never
		// auto-load global skills unless explicitly selected.
		args := []string{"--no-skills"}
		for _, p := range skillPaths {
			args = append(args, "--skill", p)
		}
		plan.Args = args
	case "kimi":
		// Materialize an aggregate directory of symlinks per agent and point
		// --skills-dir at it (replacement semantics per docs).
		dir, err := materializeSkillAggregate(agent.ID, base, skillPaths)
		if err != nil {
			return nil, err
		}
		plan.Args = []string{"--skills-dir", dir}
		plan.Warnings = append(plan.Warnings, "kimi --skills-dir semantics (replace vs append) pending verification")
	case "opencode":
		// Inline config: extra skill sources + deny-all permission with
		// explicit allows for the selected skills only.
		cfg := map[string]any{"skills": skillPaths}
		permission := map[string]any{"*": "deny"}
		for _, ref := range agent.Skills {
			permission[ref.Name] = "allow"
		}
		cfg["permission"] = map[string]any{"skill": permission}
		raw, err := json.Marshal(cfg)
		if err != nil {
			return nil, err
		}
		plan.Env = []string{"OPENCODE_CONFIG_CONTENT=" + string(raw)}
	case "claude":
		dir, err := materializeSkillAggregate(agent.ID, base, skillPaths)
		if err != nil {
			return nil, err
		}
		plan.Env = []string{"CLAUDE_CONFIG_DIR=" + dir}
		plan.Warnings = append(plan.Warnings, "claude sandbox: hook files must live inside the sandbox dir")
	case "codex":
		dir, err := materializeSkillAggregate(agent.ID, base, skillPaths)
		if err != nil {
			return nil, err
		}
		plan.Env = []string{"CODEX_HOME=" + dir}
		plan.Warnings = append(plan.Warnings, "codex skills is experimental")
	case "kilo", "kilocode":
		dir, err := materializeSkillAggregate(agent.ID, "kilo", skillPaths)
		if err != nil {
			return nil, err
		}
		// NOTE: merged with any existing KILO_CONFIG_CONTENT (hook plugin) at
		// the injection site — see applyCustomAgentToTerminalCommand.
		raw, err := json.Marshal(map[string]any{"skills": map[string]any{"paths": []string{dir}}})
		if err != nil {
			return nil, err
		}
		plan.Env = []string{skillKiloConfigContentEnv + "=" + string(raw)}
		plan.Warnings = append(plan.Warnings, "kilo global dir exclusion pending verification")
	}
	// Extra env from the definition itself (advanced).
	for k, v := range agent.ExtraEnv {
		if k == "CLAUDE_CONFIG_DIR" || k == "CODEX_HOME" || k == "OPENCODE_CONFIG_CONTENT" || k == skillKiloConfigContentEnv {
			continue // reserved keys; ignore user overrides
		}
		plan.Env = append(plan.Env, k+"="+v)
	}
	return plan, nil
}

const skillKiloConfigContentEnv = "KILO_CONFIG_CONTENT"

// materializeSkillAggregate builds ~/.config/pocket-studio/skill-sandboxes/
// <profile>/<agent>/ with a skills/ subdir of symlinks to the selected skills,
// plus agent-specific credential links. Idempotent per launch.
func materializeSkillAggregate(profileID string, agent string, skillPaths []string) (string, error) {
	if profileID == "" {
		profileID = "adhoc"
	}
	profileID = strings.ToLower(validDirSegment(profileID))
	base := filepath.Join(userConfigDir(), "pocket-studio", "skill-sandboxes", profileID, agent)
	skillsDir := filepath.Join(base, "skills")
	_ = os.RemoveAll(skillsDir)
	if err := os.MkdirAll(skillsDir, 0o755); err != nil {
		return "", err
	}
	for _, p := range skillPaths {
		link := filepath.Join(skillsDir, filepath.Base(p))
		if err := os.Symlink(p, link); err != nil {
			return "", err
		}
	}
	switch agent {
	case "claude":
		home, _ := os.UserHomeDir()
		if link := filepath.Join(base, ".credentials.json"); home != "" {
			if _, err := os.Stat(filepath.Join(home, ".claude", ".credentials.json")); err == nil {
				_ = os.Remove(link)
				_ = os.Symlink(filepath.Join(home, ".claude", ".credentials.json"), link)
			}
		}
	case "codex":
		home, _ := os.UserHomeDir()
		if home != "" {
			if _, err := os.Stat(filepath.Join(home, ".codex", "auth.json")); err == nil {
				link := filepath.Join(base, "auth.json")
				_ = os.Remove(link)
				_ = os.Symlink(filepath.Join(home, ".codex", "auth.json"), link)
			}
		}
	}
	if agent == "kimi" {
		// kimi --skills-dir points at the aggregate directory itself.
		return skillsDir, nil
	}
	return base, nil
}

func validDirSegment(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	out := b.String()
	if len(out) > 48 {
		out = out[:48]
	}
	return strings.Trim(out, "-")
}

// applyCustomAgentToTerminalCommand rewrites the terminal command and env
// for a launch with a custom agent definition. The definition's base CLI
// replaces the requested command, so the frontend only needs to pass
// custom_agent_id — the daemon owns the translation (skills + prompt).
func applyCustomAgentToTerminalCommand(command string, agentID string, env []string) (string, []string, string, error) {
	if strings.TrimSpace(agentID) == "" {
		return command, env, "", nil
	}
	agent, ok := lookupCustomAgent(agentID)
	if !ok {
		return command, env, "", fmt.Errorf("custom agent %q not found", agentID)
	}
	plan, err := buildSkillLaunchPlan(agent.BaseAgent, agent)
	if err != nil {
		return command, env, "", err
	}
	command = baseAgentCommand(agent.BaseAgent)
	// Per-CLI system prompt injection.
	if prompt := strings.TrimSpace(agent.SystemPrompt); prompt != "" {
		switch agent.BaseAgent {
		case "pi":
			command += " --append-system-prompt " + shellQuote(prompt)
		case "claude":
			command += " --append-system-prompt " + shellQuote(prompt)
		case "opencode":
			// opencode has no prompt flag; inject as AGENTS.md into cwd-adjacent
			// env via OPENCODE_CONFIG_CONTENT is not possible for prompts, so
			// write a scoped instructions file the agent reads on start.
			dir, writeErr := materializeAgentPromptFile(agent, prompt)
			if writeErr == nil {
				env = replaceEnv(env, "POCKET_STUDIO_AGENT_PROMPT_FILE", dir)
			}
		case "codex":
			// codex reads instructions from AGENTS.md in CODEX_HOME or cwd;
			// APPEND-ONLY: we materialize into the sandbox config.toml is not
			// supported, so prepend via the -c CLI option for extra instructions
			// is not available. Fall back to writing AGENTS.md in the sandbox.
			dir, writeErr := materializeAgentPromptFile(agent, prompt)
			if writeErr == nil {
				env = replaceEnv(env, "POCKET_STUDIO_AGENT_PROMPT_FILE", dir)
			}
		case "kimi", "kilo", "kilocode":
			// Kimi/Kilo read AGENTS.md-equivalents from the config dir; use the
			// same materialized prompt file approach.
			dir, writeErr := materializeAgentPromptFile(agent, prompt)
			if writeErr == nil {
				env = replaceEnv(env, "POCKET_STUDIO_AGENT_PROMPT_FILE", dir)
			}
		}
	}
	if len(agent.ExtraArgs) > 0 {
		if extra, ok := agent.ExtraArgs[agent.BaseAgent]; ok {
			command += " " + strings.Join(extra, " ")
		}
	}
	if len(plan.Args) > 0 {
		command += " " + strings.Join(plan.Args, " ")
	}
	for _, kv := range plan.Env {
		key, value, _ := strings.Cut(kv, "=")
		if key == skillKiloConfigContentEnv {
			merged, mergeErr := mergeKiloConfigContentEnv(env, value)
			if mergeErr != nil {
				continue
			}
			env = replaceEnv(env, key, merged)
			continue
		}
		env = replaceEnv(env, key, value)
	}
	return command, env, agent.BaseAgent, nil
}

// materializeAgentPromptFile writes the agent's system prompt to a per-agent
// instructions file (AGENTS.md format) inside the pocket-studio config dir.
// The file path is exposed via POCKET_STUDIO_AGENT_PROMPT_FILE; base CLIs that
// cannot take prompts via flags read it on start (or the plan falls back to
// appending it to the first user turn, which the terminal user can do
// manually via /init-style prompts).
func materializeAgentPromptFile(agent protocol.CustomAgent, prompt string) (string, error) {
	dir := filepath.Join(userConfigDir(), "pocket-studio", "agent-prompts", validDirSegment(agent.ID))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	target := filepath.Join(dir, "AGENTS.md")
	content := fmt.Sprintf("# %s\n\n%s\n", agent.Name, prompt)
	if err := writeFileAtomic(target, []byte(content), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

// mergeKiloConfigContentEnv merges a new skills config JSON into any existing
// KILO_CONFIG_CONTENT value (set by the terminal hook plugin), key by key.
func mergeKiloConfigContentEnv(env []string, incoming string) (string, error) {
	existing := ""
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok && k == skillKiloConfigContentEnv {
			existing = v
			break
		}
	}
	if existing == "" {
		return incoming, nil
	}
	var base, extra map[string]any
	if err := json.Unmarshal([]byte(existing), &base); err != nil {
		return incoming, nil
	}
	if err := json.Unmarshal([]byte(incoming), &extra); err != nil {
		return "", err
	}
	for k, v := range extra {
		if prev, ok := base[k].(map[string]any); ok {
			if next, ok := v.(map[string]any); ok {
				for kk, vv := range next {
					prev[kk] = vv
				}
				base[k] = prev
				continue
			}
		}
		base[k] = v
	}
	merged, err := json.Marshal(base)
	if err != nil {
		return "", err
	}
	return string(merged), nil
}

func replaceEnv(env []string, key string, value string) []string {
	prefix := key + "="
	for i, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix + value)
}
