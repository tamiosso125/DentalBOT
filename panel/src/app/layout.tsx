import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "DentalBOT · Painel" };

// Applies the saved theme before first paint so dark mode does not flash light.
const THEME_SCRIPT = `try{var t=localStorage.getItem("dentalbot-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
