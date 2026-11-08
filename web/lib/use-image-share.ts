"use client";

import { useEffect, useRef, useState } from "react";

/** Copy-image / native-share plumbing for a canvas card. X's web intent cannot attach an image,
 * so on desktop the post carries text + link and the card goes in by hand via copy image; where
 * the OS share sheet accepts files (phones), the image rides along with the text. */
export function useImageShare(render: () => Promise<Blob>, text: string, link: string, filename: string) {
  const [copied, setCopied] = useState(false);
  const [imageError, setImageError] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  // Decided after mount so the server render has no share sheet to ask. Touch devices only:
  // a desktop share sheet has no X target, the web intent does.
  const [canShareFiles, setCanShareFiles] = useState(false);
  useEffect(() => {
    const probe = new File([new Uint8Array(1)], "p.png", { type: "image/png" });
    setCanShareFiles(matchMedia("(pointer: coarse)").matches && typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] }));
  }, []);

  async function copyImage() {
    try {
      // Promise form: Safari needs the write to start inside the click.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": render() })]);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch { setImageError(true); }
  }
  async function shareNative() {
    try {
      const file = new File([await render()], filename, { type: "image/png" });
      await navigator.share({ text: `${text}\n${link}`, files: [file] });
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") setImageError(true);
    }
  }
  return { copied, imageError, canShareFiles, copyImage, shareNative };
}
