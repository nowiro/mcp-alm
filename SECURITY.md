# Polityka bezpieczeństwa

## Wspierane wersje

| Wersja | Wspierana   |
| ------ | ----------- |
| 1.x    | ✅          |
| 0.x    | unsupported |

## Zgłaszanie podatności

**NIE otwieraj publicznego issue GitHub dla podatności bezpieczeństwa.**

Skorzystaj z [private vulnerability reporting GitHub](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
na tym repozytorium.

W zgłoszeniu dołącz:

1. Opis podatności i jej potencjalnego impactu.
2. Kroki do reprodukcji.
3. Dotknięte wersje.
4. Proof-of-concept (traktowany jako poufny).

Potwierdzenie otrzymujesz w ciągu **48 godzin**, plan remediacji /
mitygacji w ciągu **14 dni** dla critical issues. Coordinated disclosure
timeline to **90 dni** od pierwszego zgłoszenia; szczegóły mogą zostać
opublikowane gdy fix shipuje albo gdy minie 90 dni — cokolwiek pierwsze.

## Zakres

| W zakresie                                          | Poza zakresem                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| Wyciek tokena przez logi, stdout, pliki             | Podatności w samym Jira / Confluence / Figma / SonarQube / GitLab |
| Bypass write-guard                                  | Ataki network-level przeciw upstream services                     |
| Podatności wprowadzone przez ten projekt            | Ataki fizyczne / social engineering                               |
| Injection przez inputy narzędzi / bypass Zod schema | Kompromitacja hosta MCP (VS Code / IntelliJ)                      |

## Więcej szczegółów

- [**docs/explanation/security-architecture.md**](docs/explanation/security-architecture.md) — granice zaufania, model zagrożeń, pełny katalog kontroli (token storage, redaction, write-guard, SSRF, headers, retry/dedup, supply chain, stdio integrity).
- [**docs/getting-started/enterprise-intranet.md**](docs/getting-started/enterprise-intranet.md) — proxy korporacyjne, prywatne CA, instalacja air-gapped, DLP, trwały audit log.
- [**.github/instructions/security.instructions.md**](.github/instructions/security.instructions.md) — reguły wymuszane na agentach podczas edycji kodu.
