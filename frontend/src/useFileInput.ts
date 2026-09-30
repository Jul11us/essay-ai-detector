import { useRef, useState } from "react";
import { isDetectErr, previewFile, type FilePreview } from "./api";

/**
 * 上传文件和它的文字预览。换文件会掐掉上一次还在跑的预览请求；
 * `onChange` 在每次换文件或清除时先被调用，用来丢掉上一份检测结果。
 */
export function useFileInput(onChange: () => void) {
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onFile = (next: File | null) => {
    previewAbort.current?.abort();
    setFile(next);
    onChange();
    setFilePreview(null);
    setPreviewError(null);
    if (!next) {
      if (fileInputRef.current) fileInputRef.current.value = "";
      setPreviewBusy(false);
      return;
    }
    const ctrl = new AbortController();
    previewAbort.current = ctrl;
    setPreviewBusy(true);
    void previewFile(next, ctrl.signal)
      .then((data) => {
        if (previewAbort.current !== ctrl) return;
        if (isDetectErr(data)) setPreviewError(data.message);
        else setFilePreview(data);
      })
      .catch(() => {
        if (previewAbort.current === ctrl) setPreviewError("文件预览失败，请重新上传。");
      })
      .finally(() => {
        if (previewAbort.current === ctrl) setPreviewBusy(false);
      });
  };

  return { file, filePreview, previewBusy, previewError, fileInputRef, onFile };
}
