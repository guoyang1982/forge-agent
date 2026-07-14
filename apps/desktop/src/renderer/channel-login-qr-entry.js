import QRCode from "qrcode";

globalThis.ForgeChannelLoginQr = {
  async toDataUrl(text) {
    return QRCode.toDataURL(text, {
      margin: 1,
      width: 280,
      errorCorrectionLevel: "M",
    });
  },
};
