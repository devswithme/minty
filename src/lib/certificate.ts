import * as path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import * as QRCode from "qrcode";

type CertificateOptions = {
  studentName: string;
  courseName: string;
  scoreText: string;
  certificateId: string;
  verificationUrl: string;
  leadMentorName: string;
};

export async function generateCertificateImage(
  options: CertificateOptions,
): Promise<Buffer> {
  const templatePath =
    process.env.CERTIFICATE_TEMPLATE_PATH ||
    path.join(process.cwd(), "assets", "certificate-template.png");

  const image = await loadImage(templatePath);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");

  ctx.drawImage(image, 0, 0, image.width, image.height);

  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";

  // Student name
  ctx.font = "bold 52px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(options.studentName, 140, 470);

  // Course name
  ctx.font = "bold 36px sans-serif";
  ctx.fillText(options.courseName, 760, 555);

  // Lead mentor name (placed near score text)
  ctx.font = "bold 36px sans-serif";
  ctx.fillText(options.leadMentorName, 545, 605);

  // Score text
  ctx.font = "bold 64px sans-serif";
  ctx.fillText(`${options.scoreText} / 5`, 140, 730);

  // Certificate ID text (bottom-left area)
  ctx.font = "bold 36px";
  ctx.textAlign = "right";
  ctx.fillText(options.certificateId, 1856, 1265);

  // QR code (bottom-right area)
  const qrSize = 256;
  const qrCanvas = createCanvas(qrSize, qrSize);

  await QRCode.toCanvas(qrCanvas as any, options.verificationUrl, {
    width: qrSize,
    margin: 1,
  } as any);

  const qrX = 1610;
  const qrY = 930;
  ctx.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize);

  return canvas.toBuffer("image/png");
}
