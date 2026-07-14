import QRCode from "qrcode";

/** iLink returns a scan URL in qrcode_img_content, not a raster image. */
export async function resolveIlinkQrcodeImage(
  qrcodeImgContent?: string,
): Promise<string | undefined> {
  const content = qrcodeImgContent?.trim();
  if (!content) return undefined;
  if (content.startsWith("data:image/")) return content;
  if (/^https?:\/\//i.test(content)) {
    return QRCode.toDataURL(content, {
      margin: 1,
      width: 280,
      errorCorrectionLevel: "M",
    });
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(content) && content.length > 64) {
    return `data:image/png;base64,${content.replace(/\s/g, "")}`;
  }
  return undefined;
}
