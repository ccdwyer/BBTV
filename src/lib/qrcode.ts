import QRCode from "qrcode";
import { nanoid } from "nanoid";
import { config } from "./config";
import {
  getQrCodeForMedia,
  upsertQrCode,
  type QrCode,
} from "./db";

export function getOrCreateQrId(mediaId: string, qrType: QrCode["qr_type"]): string {
  const existing = getQrCodeForMedia(mediaId, qrType);
  if (existing) return existing.id;

  const id = nanoid(8);
  upsertQrCode({ id, media_id: mediaId, qr_type: qrType });
  return id;
}

export async function generateQrSvg(qrId: string): Promise<string> {
  const url = `http://localhost:${config.port}/play/${qrId}`;
  return QRCode.toString(url, {
    type: "svg",
    margin: 1,
    width: 200,
    errorCorrectionLevel: "M",
  });
}

export function getPlayUrl(qrId: string): string {
  return `http://localhost:${config.port}/play/${qrId}`;
}

export async function generateSpecialQrSvg(specialId: string): Promise<string> {
  const url = `http://localhost:${config.port}/play/${specialId}`;
  return QRCode.toString(url, {
    type: "svg",
    margin: 1,
    width: 200,
    errorCorrectionLevel: "M",
  });
}
