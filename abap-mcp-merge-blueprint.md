# ABAP MCP Birleştirme Blueprint'i

> Bu doküman, **Dassian ADT** ve **Mario MCP-ABAP-ADT** repolarını birleştirip tek bir güçlü MCP server + Claude.ai skill oluşturmak için Claude Code'a verilecek specification'dır.

## Kaynak Repolar

| Repo | URL | Rol |
|------|-----|-----|
| Dassian ADT (fork) | `https://github.com/DassianInc/dassian-adt` | **TEMEL** — altyapı, tüm write/activate/transport/quality/run/git işlemleri |
| Mario MCP-ABAP-ADT | `https://github.com/mario-andreschak/mcp-abap-adt` | **REFERANS** — sezgisel read-only tool isimleri, basit handler yapısı |

## Kritik Karar: Dassian TEMEL ALINACAK

Dassian zaten Mario'nun süper seti. Mario'dan alınacak şeyler sadece:

1. **Kolay tool alias'ları** (opsiyonel, aşağıda detaylı)
2. **GetTransaction handler mantığı** — Dassian'da transaction okuma toolu yok
3. **GetTableContents'in custom service yaklaşımı** — `/z_mcp_abap_adt/z_tablecontent` endpoint'i (Dassian zaten `datapreview/freestyle` ile çözüyor ama alternatif olarak eklenebilir)

---

## Birleştirilmiş Tool Listesi (Scope: Okuma + Oluşturma + Activate)

### Kategori 1: Okuma (Read) — 12 tool

| # | Tool Adı | Kaynak | Açıklama |
|---|----------|--------|----------|
| 1 | `abap_get_source` | Dassian | Herhangi bir ABAP nesnesinin kaynak kodunu oku (CLAS, PROG, FUGR/FF, DDLS vs.) |
| 2 | `abap_get_function_group` | Dassian | Tüm function group source'unu tek seferde oku |
| 3 | `abap_search` | Dassian | Nesne ara (wildcard destekli) |
| 4 | `abap_object_info` | Dassian | Nesne metadata: paket, transport layer, aktif/inaktif durumu |
| 5 | `abap_table` | Dassian | Tablo/CDS view içeriğini oku (WHERE, LIKE, BETWEEN destekli) |
| 6 | `abap_query` | Dassian | Serbest SQL sorgusu çalıştır |
| 7 | `abap_where_used` | Dassian (Quality) | Where-used list — nesneye referans veren tüm nesneler |
| 8 | `abap_get_dump` | Dassian (System) | ST22 short dump'ları oku |
| 9 | `abap_get_transaction` | **YENİ** (Mario'dan adapt) | Transaction detaylarını oku — Mario'nun `GetTransaction` mantığı |
| 10 | `abap_atc_variants` | Dassian (Quality) | ATC check variant bilgisi |
| 11 | `git_repos` | Dassian (Git) | gCTS repository listesi |
| 12 | `raw_http` | Dassian (System) | Raw ADT HTTP request (escape hatch) |

### Kategori 2: Oluşturma (Create/Write) — 6 tool

| # | Tool Adı | Kaynak | Açıklama |
|---|----------|--------|----------|
| 13 | `abap_create` | Dassian | Yeni ABAP nesnesi oluştur (CLAS, PROG, DDLS, TABL, DTEL, DOMA, INTF, FUGR, BDEF vs.) |
| 14 | `abap_set_source` | Dassian | Kaynak kodu yaz (lock → write → unlock otomatik) |
| 15 | `abap_set_class_include` | Dassian | Class include'a yaz (implementations, definitions, macros, testclasses) |
| 16 | `abap_edit_method` | Dassian | Tek bir metodu cerrahi olarak düzenle (find/replace scoped to method) |
| 17 | `abap_delete` | Dassian | Nesne sil |
| 18 | `abap_unlock` | Dassian (Run) | SM12 kilidini serbest bırak |

### Kategori 3: Activate — 3 tool

| # | Tool Adı | Kaynak | Açıklama |
|---|----------|--------|----------|
| 19 | `abap_activate` | Dassian | Tek nesneyi aktive et |
| 20 | `abap_activate_batch` | Dassian | Birden fazla nesneyi toplu aktive et |
| 21 | `abap_syntax_check` | Dassian | Syntax check — activate öncesi doğrulama |

### Kategori 4: Kalite (Quality) — 2 tool

| # | Tool Adı | Kaynak | Açıklama |
|---|----------|--------|----------|
| 22 | `abap_atc_run` | Dassian | ATC (ABAP Test Cockpit) çalıştır |
| 23 | `abap_run` | Dassian | Geçici class oluştur, ABAP kodu çalıştır, çıktı al, temizle |

### Kategori 5: Sistem — 3 tool

| # | Tool Adı | Kaynak | Açıklama |
|---|----------|--------|----------|
| 24 | `login` | Dassian | SAP oturumu başlat |
| 25 | `healthcheck` | Dassian | SAP bağlantısını kontrol et |
| 26 | `git_pull` | Dassian | gCTS pull |

### Kategori 6: Transport (opsiyonel ama dahil) — 6 tool

| # | Tool Adı | Kaynak | Açıklama |
|---|----------|--------|----------|
| 27 | `transport_create` | Dassian | Transport oluştur |
| 28 | `transport_assign` | Dassian | Nesneyi transport'a ata |
| 29 | `transport_release` | Dassian | Transport release et |
| 30 | `transport_list` | Dassian | Açık transportları listele |
| 31 | `transport_info` | Dassian | Nesnenin transport atamasını göster |
| 32 | `transport_contents` | Dassian | Transport içeriğini listele |

**Toplam: 32 tool** (transport dahil)

---

## Yapılacak Değişiklikler

### 1. Yeni Handler: `abap_get_transaction`

Mario'nun `handleGetTransaction.ts` mantığını Dassian'ın handler yapısına adapt et:

```typescript
// SourceHandlers.ts veya yeni bir DdicHandlers.ts içine ekle
// Mario'nun yaklaşımı:
//   GET /sap/bc/adt/vit/wb/object_type/tran/object_name/{TCODE}
// Dassian'ın ADT client'ı ile:
//   this.adtclient üzerinden raw request veya h.request kullanılır

{
  name: 'abap_get_transaction',
  annotations: { readOnlyHint: true },
  description: 'Get transaction code details (target program, screen, etc.)',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Transaction code, e.g. VA01 or /DSN/BILLING' }
    },
    required: ['name']
  }
}
```

Handler implementasyonu:
```typescript
private async handleGetTransaction(args: any): Promise<any> {
  try {
    const h = (this.adtclient as any).h;
    const encoded = args.name.replace(/\//g, '%2f').toLowerCase();
    const response = await this.withSession(() =>
      h.request(`/sap/bc/adt/vit/wb/object_type/tran/object_name/${encoded}`, {
        method: 'GET',
        headers: { Accept: 'application/*' }
      })
    );
    return this.success({ transaction: (response as any).body });
  } catch (error: any) {
    this.fail(formatError(`abap_get_transaction(${args.name})`, error));
  }
}
```

### 2. MCP Prompts (Dassian'dan aynen al)

Dassian'ın 4 prompt'u aynen kalacak:
- `fix-atc` — ATC run + fix + activate
- `transport-review` — Transport içeriğini syntax check et
- `class-overview` — Class compact source + where-used
- `release-transport` — Check + validate + release

### 3. Transport'u Opsiyonel Yap

`index.ts`'de bir environment variable ile transport tool'larını enable/disable yap:

```typescript
const ENABLE_TRANSPORT = process.env.ENABLE_TRANSPORT !== 'false'; // default: true

// setupHandlers içinde:
if (ENABLE_TRANSPORT) {
  this.transportHandlers = new TransportHandlers(this.adtClient);
}
```

### 4. HTTP Mode (Dassian'dan aynen al)

Dassian'ın HTTP mode'u (`MCP_TRANSPORT=http`) ve login page'i aynen kalacak. Team deployment için kritik.

---

## Proje Yapısı

```
abap-mcp-unified/
├── src/
│   ├── index.ts                  # Entry point (stdio + http mode)
│   ├── auth/
│   │   └── loginPage.ts          # HTTP mode login sayfası (Dassian)
│   ├── handlers/
│   │   ├── BaseHandler.ts        # Session, validation, elicitation (Dassian)
│   │   ├── SourceHandlers.ts     # get/set source, function groups, class includes (Dassian)
│   │   ├── ObjectHandlers.ts     # create, delete, activate, search (Dassian)
│   │   ├── TransportHandlers.ts  # transport CRUD (Dassian)
│   │   ├── QualityHandlers.ts    # syntax, ATC, where-used (Dassian)
│   │   ├── DataHandlers.ts       # table, query (Dassian)
│   │   ├── RunHandlers.ts        # abap_run, unlock (Dassian)
│   │   ├── SystemHandlers.ts     # login, health, dumps, raw_http, GET TRANSACTION (yeni)
│   │   └── GitHandlers.ts        # gCTS (Dassian)
│   ├── lib/
│   │   ├── urlBuilder.ts         # ADT URL construction (Dassian)
│   │   ├── errors.ts             # Error classification + hints (Dassian)
│   │   └── logger.ts             # JSON structured logging (Dassian)
│   ├── types/
│   │   └── tools.ts              # ToolDefinition type (Dassian)
│   └── __tests__/
│       ├── unit/                  # Dassian'ın 163 unit test'i
│       ├── integration/           # Live SAP testleri
│       └── e2e/                   # Write-path lifecycle test
├── docs/                          # Dassian docs
├── scripts/                       # Dassian scripts
├── .env.example
├── package.json
├── tsconfig.json
├── jest.config.js
├── Dockerfile
├── smithery.yaml
├── LICENSE                        # MIT (her iki repo da MIT)
└── README.md                      # Birleştirilmiş README
```

---

## package.json

```json
{
  "name": "abap-mcp-unified",
  "version": "3.0.0",
  "description": "Unified MCP server for SAP ABAP development via ADT API — read, write, activate, test, and deploy ABAP code.",
  "main": "dist/index.js",
  "scripts": {
    "test": "jest --testPathPattern='__tests__/unit'",
    "test:live": "jest --testPathPattern='__tests__/integration' --runInBand",
    "test:e2e": "jest --testPathPattern='__tests__/e2e' --runInBand --testTimeout=60000",
    "build": "tsc -p tsconfig.json",
    "start": "node ./dist/index.js",
    "dev": "npx @modelcontextprotocol/inspector ./dist/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.28.0",
    "@types/node": "^22.10.10",
    "abap-adt-api": "^7.1.2",
    "dotenv": "^16.4.7",
    "typescript": "^5.7.3"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.5"
  },
  "license": "MIT"
}
```

**NOT:** `axios` ve `xml-js` gerekmiyor — Dassian `abap-adt-api` kütüphanesini kullanıyor, o kendi HTTP client'ını yönetiyor.

---

## .env.example

```bash
# SAP Connection
SAP_URL=https://your-sap-server:44300
SAP_USER=YOUR_USER
SAP_PASSWORD=YOUR_PASSWORD
SAP_CLIENT=100
SAP_LANGUAGE=EN

# MCP Transport (stdio or http)
MCP_TRANSPORT=stdio
MCP_HTTP_PORT=3000
MCP_HTTP_PATH=/mcp

# Feature Flags
ENABLE_TRANSPORT=true

# For self-signed certificates
NODE_TLS_REJECT_UNAUTHORIZED=0
```

---

## Claude Code'a Verilecek Prompt

Aşağıdaki prompt'u Claude Code'a ver:

```
Bu iki ABAP MCP server reposunu birleştirmem lazım:

1. TEMEL: https://github.com/DassianInc/dassian-adt (fork, gelişmiş)
2. REFERANS: https://github.com/mario-andreschak/mcp-abap-adt (orijinal, read-only)

Dassian'ı temel alarak "abap-mcp-unified" adında yeni bir proje oluştur.

Yapılacaklar:
1. Dassian reposunu klonla, "abap-mcp-unified" olarak yeniden adlandır
2. Mario'dan `abap_get_transaction` tool'unu ekle (SystemHandlers.ts'e)
   - Mario'nun handler'ı: /sap/bc/adt/vit/wb/object_type/tran/object_name/{TCODE}
   - Dassian'ın withSession + h.request yapısıyla adapt et
3. Transport tool'larını ENABLE_TRANSPORT env variable ile opsiyonel yap
4. package.json'da name'i "abap-mcp-unified", version'ı "3.0.0" yap
5. README.md'yi güncelle — her iki repoyu credit et
6. npm run build ile derle, npm test ile testleri çalıştır
7. Hata varsa düzelt, build clean olana kadar iterate et

Temel prensipler:
- Dassian'ın BaseHandler, withSession, error intelligence, elicitation yapısına DOKUNMA
- Dassian'ın 25 mevcut tool'una DOKUNMA
- Sadece EKle (abap_get_transaction) ve KONFIGURE ET (transport toggle)
- Test suite'i koru ve yeni tool için test ekle

Blueprint detayları bu dosyada: [blueprint dosyasının path'i]
```

---

## Skill Dosyası (.skill) — Claude.ai için

Proje tamamlandıktan sonra bir skill olarak da paketlenecek. Skill dosyası:

```yaml
---
name: abap-mcp-unified
description: >
  Unified MCP server for SAP ABAP development via ADT API. 
  Use this skill when the user wants to connect Claude to a SAP system,
  read ABAP source code, create/modify ABAP objects, activate them,
  run ATC checks, execute ABAP code, or manage transports.
  Supports all common ABAP object types: CLAS, PROG, FUGR, DDLS, TABL, 
  DTEL, DOMA, INTF, BDEF, SRVD, SRVB, ENHO, VIEW, and more.
  Includes session recovery, error intelligence, MCP elicitation,
  and both stdio and HTTP transport modes.
---

# ABAP MCP Unified

## Setup
1. Clone: `git clone <repo-url>`
2. `npm install && npm run build`
3. Configure `.env` with SAP connection details
4. Add to Claude Code MCP settings

## Quick Reference
- Read: `abap_get_source`, `abap_search`, `abap_table`, `abap_query`
- Write: `abap_create` → `abap_set_source` → `abap_activate`
- Quality: `abap_syntax_check`, `abap_atc_run`, `abap_where_used`
- Run: `abap_run` (temp class, execute, capture output)
- Transport: `transport_create`, `transport_assign`, `transport_release`
```

---

## Credits

- **Mario Andreschak** — orijinal MCP server yapısı
- **Marcello Urbani** — `abap-adt-api` kütüphanesi  
- **Dassian Inc.** — validation, elicitation, error handling, test suite
- **Sen (kuzen)** — birleştirme fikri ve yönlendirme
