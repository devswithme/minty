import { writeFile } from "node:fs/promises";
import { generateCertificateImage } from "../lib/certificate";

async function main() {
  const buffer = await generateCertificateImage({
    certificateId: "ABCDEFGHIJKL",
    studentName: "John Doe",
    courseName: "Fullstack Web Development Bootcamp",
    scoreText: "4.67",
    verificationUrl: "https://example.com",
    leadMentorName: "Jane Doe",
  });

  await writeFile("cert-preview.png", buffer);
}

main().catch(console.error);
