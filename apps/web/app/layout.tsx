import type { Metadata, Viewport } from "next";
import "vazirmatn/Vazirmatn-Variable-font-face.css";
import "./globals.css";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: "ایجنت دپلوی لیارا",
  description: "دپلوی، پایش و رفع خطای پروژه‌ها روی لیارا با یک گفتگوی فارسی",
};

export const viewport: Viewport = { themeColor: "#07080d", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
