import { useState } from "react";
import { Copy } from "lucide-react";

interface CopyButtonProps {
  value: string;
}

export function CopyButton({ value }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-button"
      type="button"
      title="复制"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "已复制" : <Copy size={17} />}
    </button>
  );
}
