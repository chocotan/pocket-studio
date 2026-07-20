type ClipboardImageData = Pick<DataTransfer, "files" | "items">;

function isImageFile(file: File | null): file is File {
  return Boolean(file?.type.toLowerCase().startsWith("image/"));
}

export function imageFilesFromClipboard(clipboardData: ClipboardImageData): File[] {
  const itemImages = Array.from(clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(isImageFile);

  if (itemImages.length > 0) return itemImages;
  return Array.from(clipboardData.files).filter(isImageFile);
}
