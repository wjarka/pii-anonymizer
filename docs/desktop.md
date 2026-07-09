# Aplikacja desktopowa — pobieranie i budowanie

## Dla kogo

Ta sama anonimizacja co w przeglądarce, ale w osobnym oknie aplikacji. Przydatne przy długich dokumentach, bo aktywne przetwarzanie nie powinno zatrzymywać się po przełączeniu do innego programu.

## Pobieranie gotowej aplikacji

1. Wejdź na https://github.com/wjarka/pii-anonymizer/releases.
2. Wybierz najnowszy release `desktop-v...`.
3. Pobierz właściwy plik:
   - macOS Apple Silicon: `pii-tools-...-mac-arm64.dmg`
   - macOS Intel: `pii-tools-...-mac-x64.dmg`
   - Windows instalator: `pii-tools-...-win-x64-setup.exe`
   - Windows portable: `pii-tools-...-win-x64-portable.exe`

## Instalacja na macOS

- Otwórz `.dmg` i przeciągnij `pii.tools` do Applications / Programy.
- Jeśli macOS blokuje pierwsze uruchomienie, kliknij aplikację prawym przyciskiem i wybierz **Otwórz**. To ograniczenie wynika z braku podpisu/notaryzacji pierwszych buildów.

## Instalacja na Windows

- Uruchom `...setup.exe`.
- Jeśli SmartScreen ostrzega przed nieznanym wydawcą, wybierz **Więcej informacji -> Uruchom mimo to** tylko jeśli plik pobrano z oficjalnego GitHub Releases projektu.
- Wersja portable nie wymaga instalacji.

## Modele i praca offline

- Pierwsze użycie może pobrać modele NER i komponenty środowiska uruchomieniowego; modele OCR są dołączone do aplikacji. Pobieranie może potrwać i zużyć dużo transferu.
- Kolejne uruchomienia używają lokalnego cache pobranych modeli i komponentów, więc nie powinny pobierać się ponownie.
- Pierwsza wersja desktopowa nie gwarantuje pełnego pierwszego uruchomienia offline. Jeśli wyczyścisz dane aplikacji/cache, zależności sieciowe trzeba pobrać ponownie; dołączone modele OCR pozostają dostępne.

## Przetwarzanie w tle

- Aplikacja wyłącza throttling okna Electron i włącza blokadę usypiania aplikacji podczas importu/OCR/anonimizacji.
- Możesz przełączyć się do innego programu; aktywne przetwarzanie powinno trwać dalej.
- System nadal może zwolnić pracę przy niskiej baterii, ręcznym uśpieniu komputera albo agresywnych ustawieniach oszczędzania energii.

## Budowanie lokalne

### Wymagania

- Node.js 20+
- npm

### macOS

```bash
npm ci
npm run electron:dist:mac
```

### Windows

```powershell
npm ci
npm run electron:dist:win
```

Gotowe pliki będą w `release/desktop/`.

## Publikowanie release'u

```bash
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

GitHub Actions buduje Windows/macOS i publikuje pliki w GitHub Releases.
