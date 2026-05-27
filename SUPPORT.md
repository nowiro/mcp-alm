# Wsparcie — mcp-alm

Wybierz kanał odpowiedni dla swojego problemu.

## Pytania o użycie

- **Czytasz pierwszy raz?** → [`docs/getting-started/quickstart.md`](docs/getting-started/quickstart.md)
- **Setup VS Code / IntelliJ** → [`docs/getting-started/vscode-setup.md`](docs/getting-started/vscode-setup.md)
  / [`docs/getting-started/intellij-setup.md`](docs/getting-started/intellij-setup.md)
- **Za firewallem korporacyjnym (proxy, prywatne CA)** →
  [`docs/getting-started/enterprise-intranet.md`](docs/getting-started/enterprise-intranet.md)
- **Coś nie działa** → [`docs/how-to/troubleshooting.md`](docs/how-to/troubleshooting.md)
- **Co znaczy ten kod błędu?** → [`docs/reference/error-codes.md`](docs/reference/error-codes.md)

`npm run doctor` waliduje config + dostęp do baseUrl + Node version. Uruchom
go pierwsze.

## Bug reports / feature requests

Otwórz issue używając templatek:

- [Bug report](https://github.com/nowiro/mcp-alm/issues/new?template=bug.yml)
- [Feature request](https://github.com/nowiro/mcp-alm/issues/new?template=feature.yml)

Przed otwarciem: poszukaj w istniejących issues (otwartych i zamkniętych) —
duplikaty trafiają na koniec kolejki.

## Podatności bezpieczeństwa

**NIE otwieraj publicznego issue.** Patrz [SECURITY.md](SECURITY.md) —
prywatne disclosure przez [GitHub Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability).

Potwierdzenie otrzymania: 48 h. Plan remediacji dla critical: 14 dni.

## Code of Conduct — zgłoszenia

Patrz [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Zgłoszenia naruszeń przez
prywatne kanały do maintainerów (GitHub private advisory albo e-mail
ownerów z CODEOWNERS).

## Komercyjne wsparcie

Brak. Projekt jest internal/community-maintained.

## Co nie jest wspierane

- **Podatności w samych Jira / Confluence / Figma / SonarQube / GitLab** —
  zgłaszaj do dostawców tych systemów.
- **Custom konektory poza pięcioma serwerami z głównego repo** — fork i
  utrzymuj u siebie; chętnie zobaczymy ADR z uzasadnieniem dlaczego coś
  powinno wejść do core.
- **Wersje Node < 22** — twardo wymagane przez natywny `fetch`,
  `AbortSignal.any`, `crypto.timingSafeEqual`. Nie planujemy backportu.
