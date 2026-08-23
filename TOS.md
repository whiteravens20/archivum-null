# Terms of Service — Archivum Null

**Last Updated:** August 22, 2026

> ⚠️ **NOTICE:** This is a placeholder template. Replace with a legally generated Terms of Service document appropriate for your jurisdiction before deploying to production.

---

## 1. Service Description

Archivum Null ("the Service") is a zero-knowledge encrypted file relay. Files are encrypted client-side before upload, and the encryption key never leaves the user's browser. The server stores only encrypted ciphertext.

## 2. No Account Required

The Service does not require user accounts, cookies, or any form of identity verification. All uploads are anonymous.

## 3. Acceptable Use

You agree NOT to use the Service to:

- Upload, transmit, or distribute any content that is illegal under applicable law
- Distribute malware, viruses, or any harmful software
- Infringe on intellectual property rights
- Engage in harassment, abuse, or any form of harm against individuals
- Bypass any security controls or access restrictions
- Use the Service for purposes that could damage, disable, or impair the Service

## 4. File Retention

- Files are stored as encrypted ciphertext only
- Files are automatically deleted when:
  - The configured TTL (time-to-live) expires
  - The maximum download count is reached
- The operator may delete any vault at any time without notice

## 5. No Warranty

The Service is provided "AS IS" without warranty of any kind. The operator does not guarantee:

- Availability or uptime
- Data integrity or preservation
- Security beyond the stated architecture

## 6. Limitation of Liability

The operator is not liable for any damages resulting from the use of this Service, including but not limited to data loss, security breaches, or service interruptions.

## 7. Privacy

- No accounts or identities are stored
- No analytics or tracking are employed
- No cookies are set
- IP addresses are temporarily held in memory for rate limiting and are never persisted
- The operator has no ability to decrypt uploaded files

### 7.1 Outbound connections

By default the Service initiates no outbound connections of its own. Two optional
features, both configured by the operator, are the only exceptions:

- **Bot protection (Cloudflare Turnstile).** When enabled, your browser loads a
  challenge widget from Cloudflare and the server verifies the resulting token with
  Cloudflare. Cloudflare therefore sees your IP address as part of that check. This
  is visible to you — the widget is rendered on the upload page.
- **Version check.** When enabled, the server periodically asks GitHub's public API
  which release is the newest, so the operator can be told an update is available.
  The request carries no information about you, about any upload, or about which
  version the server runs — GitHub sees only the server's own IP address. It is not
  triggered by anything you do, and the result is shown only in the operator's
  administrative panel.

Neither feature transmits file contents, filenames, encryption keys, or vault
identifiers. Both can be turned off by the operator, and both are off unless
explicitly enabled.

## 8. Content Responsibility

Users are solely responsible for the content they upload and the links they share. The operator has no knowledge of file contents due to the zero-knowledge architecture.

## 9. Compliance with Law

The operator will comply with valid legal processes. Due to the zero-knowledge architecture, the operator can only provide:

- Vault metadata (size, timestamps)
- The encrypted ciphertext (which cannot be decrypted without the user's key)

## 10. Changes to Terms

These Terms may be updated at any time. Continued use of the Service constitutes acceptance of updated Terms.

---

**Contact:** Replace with your contact information.
