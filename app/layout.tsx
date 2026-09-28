import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Schibsted_Grotesk } from 'next/font/google';
import './globals.css';

const sans = Schibsted_Grotesk({ subsets: ['latin'], variable: '--font-schibsted', display: 'swap' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Campaign planner',
  description: 'Describe a business in a sentence; get ranked publishers, persona-tuned post-purchase creatives and a campaign config.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f4f1' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1110' },
  ],
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} antialiased`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
