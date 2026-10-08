import { NextResponse } from 'next/server';
import fs from 'node:fs';
import path from 'node:path';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const versionFilePath = path.resolve(process.cwd(), 'public/downloads/version.json');

    let versionData = {
      version: '1.0.0',
      release_date: '2026-10-08',
      download_url: '/downloads/support.cfe',
      min_supported_version: '1.0.0',
      release_notes: 'Стабильный релиз агента телеметрии 1C NOC',
    };

    if (fs.existsSync(versionFilePath)) {
      const rawContent = fs.readFileSync(versionFilePath, 'utf8');
      versionData = JSON.parse(rawContent);
    }

    return NextResponse.json(versionData, {
      status: 200,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to retrieve version information', details: String(error) },
      { status: 500 }
    );
  }
}
