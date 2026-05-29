---
mode: ask
description: 'Refine a rough request into a sharper, well-structured prompt and show it back for approval. Does not execute, edit files, or call tools.'
---

# /refine

Zamienia surowy zarys w precyzyjny, dobrze ustrukturyzowany prompt — i **pokazuje go do akceptacji**. Niczego nie wykonuje, nie edytuje plików, nie woła narzędzi i nie wysyła w Twoim imieniu. To czysta redakcja promptu.

## Co dopracować

Weź tekst, który podałem wraz z `/refine`. Jeśli nic nie dołączyłem — weź moją poprzednią wiadomość. Zaznaczony kod/fragment traktuj jako **kontekst**, nie jako rzecz do zmiany.

## Co zrób

1. **Zrozum intencję** — o co naprawdę chodzi i jaki rezultat ma powstać. Nie zmieniaj sensu.
2. **Domknij braki** — dopisz to, czego dobry prompt potrzebuje, a czego w drafcie nie ma:
   - cel i kryterium sukcesu (kiedy zadanie jest „zrobione"),
   - istotny kontekst (pliki, framework, target, ograniczenia),
   - oczekiwany format i zakres outputu,
   - edge-case'y oraz czego wprost NIE robić.
3. **Nie wymyślaj wymagań.** Czego nie wiesz — nie zgaduj; zapisz jako założenie albo zadaj pytanie (pkt 5).
4. **Trzymaj zwięzłość.** Lepszy prompt ≠ dłuższy. Tnij lanie wody.
5. **Maks. 3 pytania doprecyzowujące** — tylko gdy bez odpowiedzi musiałbyś zgadywać. Jeśli draft jest jasny, pomiń.

## Format odpowiedzi

1. **Dopracowany prompt** — w osobnym bloku kodu (typu `text`), gotowy do skopiowania.
2. **Co zmieniłem** — 2–5 punktów: co dodałem/wyostrzyłem i po co.
3. **Założenia** — jeśli jakieś przyjąłeś.
4. **Pytania** — maks. 3, jeśli potrzebne.
5. Na końcu krótka notka: _„Skopiuj powyższy prompt i uruchom go u siebie — albo napisz, co jeszcze doprecyzować."_

## Czego NIE robić

- Nie wykonuj zadania z draftu — to ma być wyłącznie redakcja promptu.
- Nie edytuj plików, nie odpalaj komend, nie wołaj narzędzi/MCP.
- Twoim outputem jest **dopracowany prompt**, a nie jego wynik.
