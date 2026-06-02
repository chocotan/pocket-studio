import { useEffect, useRef, useState } from "react";
import { RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  loadShortcutConfig,
  normalizeShortcut,
  resetShortcutConfig,
  saveShortcutConfig,
  shortcutFromParts,
  type ShortcutAction,
} from "./shortcut-settings";

export function ShortcutSettingsContent() {
  const [shortcuts, setShortcuts] = useState(() => loadShortcutConfig());
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);
  const [recordedShortcut, setRecordedShortcut] = useState("");
  const [saved, setSaved] = useState(false);
  const recordingKeysRef = useRef<Set<string>>(new Set());
  const recordingModifiersRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!recordingAction) return;
    const action = recordingAction;
    recordingKeysRef.current = new Set();
    recordingModifiersRef.current = new Set();
    setRecordedShortcut("");

    function captureShortcut(key: string) {
      const nextShortcut = shortcutFromParts(key, recordingModifiersRef.current);
      setShortcuts((prev) => ({ ...prev, [action]: nextShortcut }));
      setRecordedShortcut(nextShortcut);
      setSaved(false);
    }

    function updateModifierState(event: KeyboardEvent) {
      const modifiers = recordingModifiersRef.current;
      if (event.ctrlKey) modifiers.add("Ctrl");
      if (event.altKey) modifiers.add("Alt");
      if (event.metaKey) modifiers.add("Meta");
      if (event.shiftKey) modifiers.add("Shift");
    }

    function handleKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        recordingKeysRef.current.clear();
        recordingModifiersRef.current.clear();
        setRecordingAction(null);
        setRecordedShortcut("");
        return;
      }
      recordingKeysRef.current.add(event.code || event.key);
      updateModifierState(event);
      if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) return;
      if (isModifierOnly(event.key)) return;
      captureShortcut(event.key);
    }

    function handleKeyUp(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (!isModifierOnly(event.key) && recordingModifiersRef.current.size > 0) {
        captureShortcut(event.key);
      }
      recordingKeysRef.current.delete(event.code || event.key);
      if (recordingKeysRef.current.size === 0) {
        setRecordingAction(null);
        setRecordedShortcut("");
        recordingModifiersRef.current.clear();
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
      recordingKeysRef.current.clear();
      recordingModifiersRef.current.clear();
    };
  }, [recordingAction]);

  function handleShortcutChange(action: ShortcutAction, value: string) {
    setShortcuts((prev) => ({ ...prev, [action]: value }));
    setSaved(false);
  }

  function handleSave() {
    const normalized = Object.fromEntries(
      SHORTCUT_ACTIONS.map((action) => [action, normalizeShortcut(shortcuts[action])])
    ) as Record<ShortcutAction, string>;
    saveShortcutConfig(normalized);
    setShortcuts(normalized);
    setSaved(true);
  }

  function handleReset() {
    resetShortcutConfig();
    setShortcuts(DEFAULT_SHORTCUTS);
    setRecordingAction(null);
    setRecordedShortcut("");
    recordingKeysRef.current.clear();
    recordingModifiersRef.current.clear();
    setSaved(false);
  }

  return (
    <div className="p-4">
      <div className="grid gap-2">
        {SHORTCUT_ACTIONS.map((action) => (
          <div
            key={action}
            className="grid grid-cols-[minmax(150px,1fr)_minmax(180px,260px)_auto] items-center gap-3 border border-slate-200/75 bg-slate-50 px-3 py-2"
          >
            <Label className="text-[11px] font-bold text-slate-700">
              {SHORTCUT_LABELS[action]}
            </Label>
            <Input
              value={shortcuts[action]}
              onChange={(event) => handleShortcutChange(action, event.target.value)}
              className="h-8 bg-white font-mono text-xs"
              spellCheck={false}
            />
            <Button
              type="button"
              variant={recordingAction === action ? "default" : "outline"}
              size="sm"
              onClick={() => setRecordingAction(action)}
              className="h-8 min-w-18 text-xs"
            >
              {recordingAction === action ? "录制中" : "录制"}
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
        <p className="text-[11px] leading-relaxed text-slate-500">
          {recordingAction
            ? recordedShortcut ? `已捕获 ${recordedShortcut}，松开所有按键后结束录制。` : "按下完整组合键，Esc 取消。"
            : saved ? "已保存到本机浏览器。" : "格式示例：Ctrl+H、Ctrl+J、Ctrl+K、Ctrl+L、Ctrl+N。"}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleReset} className="h-8 text-xs">
            <RotateCcw className="h-3.5 w-3.5" />
            默认
          </Button>
          <Button type="button" size="sm" onClick={handleSave} className="h-8 bg-indigo-600 text-xs text-white hover:bg-indigo-500">
            <Save className="h-3.5 w-3.5" />
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}

function isModifierOnly(key: string) {
  return key === "Control" || key === "Alt" || key === "Meta" || key === "Shift";
}
