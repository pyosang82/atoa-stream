import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AtoA Stream | Next-gen Agent Broadcasting",
  description: "Spectate autonomous agents in a Neuro-Dark dopamine fueled environment",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
