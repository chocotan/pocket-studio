All checks pass. Work complete — summary:

**Delivered:**

1. **`src/components/studio/skill-agent-manager.tsx`** (new, ~1500 lines) — `SkillAgentManagerContent({ deviceId })` with three tabs:
   - **技能库**: search, source badges （受管/共享全局）, invalid-skill warning with issue tooltip, per-skill 编辑 (jumps to editor tab), 升级 (managed skills), two-step 删除 confirm (store only); dialogs for 新建技能 (name/description/location with shared-global pollution warning), 从 Git 安装， 从本地导入
   - **自定义 Agent**: cards with base-CLI badge/skill count/prompt indicator, two-step delete; create/edit dialog with 名称， 描述， 底层 CLI (six supported only: Pi/Kimi/OpenCode/Claude Code/Kilo Code/Codex), 系统提示词 textarea with persona placeholder, skill checkbox multi-select with source badges
   - **技能编辑**: skill picker → file tree (depth-indented, dir/file icons, hover rename/delete actions, SKILL.md delete-protected client-side too) → monospace textarea editor; revision-based save with conflict banner offering 重新加载 / 以我的内容覆盖 (re-reads revision then writes); binary files show 二进制文件，不支持编辑； 新建文件 dialog with is_dir toggle
2. **`src/lib/types.ts`** — `SkillRef`, `SkillSummary`, `CustomAgent` matching backend JSON exactly
3. **`src/components/studio/studio-settings.tsx`** — new `StudioSettingsContent({ deviceId })` with 快捷键 / 技能与 Agent tab bar (ShortcutSettingsContent kept exported)
4. **`src/components/studio/studio-dashboard.tsx`** — settings dialog now renders `StudioSettingsContent` with `selectedDeviceId || devices[0]?.id`, title updated to 设置

All API calls append `?device_id=`, treat non-empty `.error` as failure, native select/checkbox used (no Select/Checkbox in this project's ui/), no new dependencies, style matches dashboard (text-xs, rounded-xl, bg-muted/40, Chinese labels, lucide icons).

**Fixed during implementation:** base-ui `DialogClose` has no `asChild` (used direct-render pattern from new-session-dialog); two-step delete confirm had an onBlur-unmount bug (blur fired when the first-step button unmounted, instantly hiding the confirm) — removed the blur reset.