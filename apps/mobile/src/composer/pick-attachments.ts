import * as Clipboard from "expo-clipboard";
import * as DocumentPicker from "expo-document-picker";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import {
  EncodingType,
  copyAsync,
  readAsStringAsync,
  writeAsStringAsync,
  cacheDirectory,
} from "expo-file-system/legacy";
import {
  estimateAttachmentChars,
  extensionOf,
  isImageFilename,
  isProbablyTextFilename,
  MAX_DATA_URL_CHARS,
  MAX_IMAGE_EDGE,
  MAX_PENDING_ATTACHMENTS,
  mimeFromName,
  opaqueAttachmentId,
  stripDataUrlBase64,
  type PendingAttachment,
} from "./attachment-types";

const MAX_TOTAL_CHARS = 5_000_000;

export type AttachmentProgress = {
  phase: "picking" | "encoding" | "reading" | "done";
  label: string;
  current: number;
  total: number;
};

export async function pickImagesFromLibrary(
  currentCount: number,
  onProgress?: (progress: AttachmentProgress) => void,
): Promise<PendingAttachment[]> {
  const room = MAX_PENDING_ATTACHMENTS - currentCount;
  if (room <= 0) throw new Error(`最多附带 ${MAX_PENDING_ATTACHMENTS} 个文件`);
  onProgress?.({ phase: "picking", label: "打开相册…", current: 0, total: 1 });
  // Android system photo picker does not need READ_MEDIA_*; forcing that permission
  // blocks picking on devices where the user denied broad gallery access.
  if (Platform.OS === "ios") {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) throw new Error("需要相册权限才能选择图片");
  }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: room,
    quality: 1,
    exif: false,
  });
  if (result.canceled) return [];
  const assets = (result.assets ?? []).slice(0, room);
  if (!assets.length) return [];
  const out: PendingAttachment[] = [];
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index]!;
    onProgress?.({
      phase: "encoding",
      label: `压缩图片 ${index + 1}/${assets.length}…`,
      current: index + 1,
      total: assets.length,
    });
    out.push(await encodeImageAsset(asset.uri, asset.fileName || guessImageName(asset.uri)));
  }
  onProgress?.({ phase: "done", label: "完成", current: assets.length, total: assets.length });
  return out;
}

export async function takePhotoAttachment(
  currentCount: number,
  onProgress?: (progress: AttachmentProgress) => void,
): Promise<PendingAttachment | null> {
  if (currentCount >= MAX_PENDING_ATTACHMENTS) {
    throw new Error(`最多附带 ${MAX_PENDING_ATTACHMENTS} 个文件`);
  }
  onProgress?.({ phase: "picking", label: "打开相机…", current: 0, total: 1 });
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error("需要相机权限才能拍照");
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ["images"],
    quality: 1,
  });
  if (result.canceled || !result.assets[0]) return null;
  const asset = result.assets[0];
  onProgress?.({ phase: "encoding", label: "压缩照片…", current: 1, total: 1 });
  const encoded = await encodeImageAsset(asset.uri, asset.fileName || `photo_${Date.now()}.jpg`);
  onProgress?.({ phase: "done", label: "完成", current: 1, total: 1 });
  return encoded;
}

export async function pickDocumentAttachments(
  currentCount: number,
  onProgress?: (progress: AttachmentProgress) => void,
): Promise<PendingAttachment[]> {
  const room = MAX_PENDING_ATTACHMENTS - currentCount;
  if (room <= 0) throw new Error(`最多附带 ${MAX_PENDING_ATTACHMENTS} 个文件`);
  onProgress?.({ phase: "picking", label: "选择文件…", current: 0, total: 1 });
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
    type: "*/*",
  });
  if (result.canceled) return [];
  const assets = result.assets.slice(0, room);
  const out: PendingAttachment[] = [];
  for (let index = 0; index < assets.length; index += 1) {
    const asset = assets[index]!;
    onProgress?.({
      phase: "reading",
      label: `读取文件 ${index + 1}/${assets.length}…`,
      current: index + 1,
      total: assets.length,
    });
    out.push(await encodeDocumentAsset(asset.uri, asset.name || "file", asset.mimeType || undefined));
  }
  onProgress?.({ phase: "done", label: "完成", current: assets.length, total: assets.length });
  return out;
}

/** Paste clipboard image (if any) into a pending attachment. */
export async function pasteClipboardImage(
  currentCount: number,
  onProgress?: (progress: AttachmentProgress) => void,
): Promise<PendingAttachment | null> {
  if (currentCount >= MAX_PENDING_ATTACHMENTS) {
    throw new Error(`最多附带 ${MAX_PENDING_ATTACHMENTS} 个文件`);
  }
  onProgress?.({ phase: "picking", label: "读取剪贴板…", current: 0, total: 1 });
  const hasImage = await Clipboard.hasImageAsync();
  if (!hasImage) throw new Error("剪贴板里没有图片");
  const image = await Clipboard.getImageAsync({ format: "png" });
  if (!image?.data) throw new Error("无法读取剪贴板图片");
  onProgress?.({ phase: "encoding", label: "压缩粘贴图片…", current: 1, total: 1 });
  const encoded = await encodeImageFromClipboardData(image.data);
  onProgress?.({ phase: "done", label: "完成", current: 1, total: 1 });
  return encoded;
}

export function assertAttachmentBudget(items: PendingAttachment[]): void {
  if (items.length > MAX_PENDING_ATTACHMENTS) {
    throw new Error(`最多附带 ${MAX_PENDING_ATTACHMENTS} 个文件`);
  }
  if (estimateAttachmentChars(items) > MAX_TOTAL_CHARS) {
    throw new Error("附件总大小超限，请减少数量或压缩图片后再试");
  }
}

async function encodeImageFromClipboardData(data: string): Promise<PendingAttachment> {
  const parsed = stripDataUrlBase64(data);
  if (!parsed?.base64) throw new Error("剪贴板图片格式无效");
  const cacheRoot = cacheDirectory;
  if (!cacheRoot) throw new Error("无法写入临时文件");
  const tempUri = `${cacheRoot}forge-clipboard-${Date.now()}.png`;
  await writeAsStringAsync(tempUri, parsed.base64, { encoding: EncodingType.Base64 });
  return encodeImageAsset(tempUri, `paste_${Date.now()}.jpg`);
}

async function ensureReadableImageUri(uri: string): Promise<string> {
  if (uri.startsWith("file://") || uri.startsWith("/")) return uri;
  const cacheRoot = cacheDirectory;
  if (!cacheRoot) return uri;
  const dest = `${cacheRoot}forge-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  try {
    await copyAsync({ from: uri, to: dest });
    return dest;
  } catch {
    // Fall back to original URI — ImageManipulator may still accept content://.
    return uri;
  }
}

async function encodeImageAsset(uri: string, name: string): Promise<PendingAttachment> {
  const localUri = await ensureReadableImageUri(uri);
  let manipulated: ImageManipulator.ImageResult;
  try {
    manipulated = await ImageManipulator.manipulateAsync(
      localUri,
      [{ resize: { width: MAX_IMAGE_EDGE } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    );
  } catch (cause) {
    throw new Error(
      cause instanceof Error ? `图片处理失败：${cause.message}` : "图片处理失败",
    );
  }
  const base64 = manipulated.base64;
  if (!base64) throw new Error("图片编码失败");
  const dataUrl = `data:image/jpeg;base64,${base64}`;
  if (dataUrl.length > MAX_DATA_URL_CHARS) {
    throw new Error(`图片过大：${name}`);
  }
  return {
    id: opaqueAttachmentId(),
    kind: "image",
    name: ensureImageName(name),
    mimeType: "image/jpeg",
    localUri: manipulated.uri || localUri,
    dataUrl,
  };
}

async function encodeDocumentAsset(
  uri: string,
  name: string,
  mimeType?: string,
): Promise<PendingAttachment> {
  const safeName = name.split(/[/\\]/).pop() || "file";
  const mime = mimeType || mimeFromName(safeName);
  if (isImageFilename(safeName, mime)) {
    return encodeImageAsset(uri, safeName);
  }
  if (isProbablyTextFilename(safeName) || mime.startsWith("text/")) {
    const text = await readAsStringAsync(uri, { encoding: EncodingType.UTF8 });
    return {
      id: opaqueAttachmentId(),
      kind: "file",
      name: safeName,
      mimeType: mime,
      text: text.slice(0, 500_000),
    };
  }
  const rawBase64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
  if (rawBase64.length > 2_800_000) {
    throw new Error(`文件过大：${safeName}`);
  }
  return {
    id: opaqueAttachmentId(),
    kind: "file",
    name: safeName,
    mimeType: mime,
    rawBase64,
  };
}

function guessImageName(uri: string): string {
  const base = uri.split(/[/\\]/).pop() || "image.jpg";
  return ensureImageName(base);
}

function ensureImageName(name: string): string {
  const ext = extensionOf(name);
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
    return name.replace(/\.[^.]+$/, ".jpg");
  }
  return `${name.replace(/\.[^.]+$/, "") || "image"}.jpg`;
}
