import type {Metadata} from 'next';
import './globals.css'; // Global styles

export const metadata: Metadata = {
  title: 'Retail NOC Dashboard — 1С POS Telemetry & Incident Monitor',
  description: 'Система мониторинга кассовых узлов 1С:Предприятие, телеметрии оборудования, удаленного доступа (AnyDesk / RuDesktop) и инцидентов.',
  openGraph: {
    title: 'Retail NOC Dashboard — 1С POS Telemetry & Incident Monitor',
    description: 'Система мониторинга кассовых узлов 1С:Предприятие, телеметрии оборудования, удаленного доступа (AnyDesk / RuDesktop) и инцидентов.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Retail NOC Dashboard — 1С POS Telemetry & Incident Monitor',
    description: 'Система мониторинга кассовых узлов 1С:Предприятие, телеметрии оборудования, удаленного доступа (AnyDesk / RuDesktop) и инцидентов.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="ru">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
