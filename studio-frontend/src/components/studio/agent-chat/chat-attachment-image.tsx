import { useEffect, useState } from "react";
import { Image as ImageIcon, Loader2, X } from "lucide-react";
import { postJSON } from "@/lib/api";
import type { ChatAttachment } from "./types";

type FileReadResult = {
  data_url?: string;
  error?: string;
};

export function ChatAttachmentImage({
  projectId,
  attachment,
  onRemove,
  variant = "composer",
}: {
  projectId: string;
  attachment: ChatAttachment;
  onRemove?: () => void;
  variant?: "composer" | "message";
}) {
  const [source, setSource] = useState(attachment.previewUrl || "");
  const [loading, setLoading] = useState(!attachment.previewUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (attachment.previewUrl) {
      setSource(attachment.previewUrl);
      setLoading(false);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setSource("");
    setLoading(true);
    setFailed(false);
    postJSON<FileReadResult>("/api/project/file/read", {
      project_id: projectId,
      path: attachment.path,
    })
      .then((result) => {
        if (cancelled) return;
        if (result.error || !result.data_url) throw new Error(result.error || "image data missing");
        setSource(result.data_url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.path, attachment.previewUrl, projectId]);

  return (
    <div
      data-testid="chat-attachment-image"
      className={`group relative shrink-0 overflow-hidden rounded-lg border border-border/70 bg-muted/30 ${
        variant === "message" ? "h-48 w-64 max-w-full" : "h-24 w-24"
      }`}
      title={attachment.name}
    >
      {source ? (
        <a href={source} target="_blank" rel="noreferrer" className="block h-full w-full">
          <img
            src={source}
            alt={attachment.name}
            className={`h-full w-full ${variant === "message" ? "object-contain" : "object-cover"}`}
            loading="lazy"
          />
        </a>
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-5 w-5" />}
          {failed && <span className="sr-only">图片加载失败</span>}
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`移除 ${attachment.name}`}
          title="移除图片"
          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md bg-black/65 text-white opacity-90 hover:bg-black"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
