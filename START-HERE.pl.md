# EnvCheck 0.2.0-alpha.1: szybki start

Lokalny kandydat alpha do zatwierdzenia. Pakiet nie jest opublikowany w npm; nazwa robocza to envcheck-workbench, private: true.

## Instalacja

Sprawdź SHA-256 archiwum względem dostarczonego SHA256SUMS. W katalogu swojej aplikacji:

```powershell
npm.cmd init --yes --ignore-scripts
npm.cmd install --save-dev --ignore-scripts "C:\Packages\envcheck-workbench-0.2.0-alpha.1.tgz"
& .\node_modules\.bin\envcheck.cmd --help
& .\node_modules\.bin\envcheck.cmd init .
& .\node_modules\.bin\envcheck.cmd scan . --json
```

```sh
npm init --yes --ignore-scripts
npm install --save-dev --ignore-scripts /absolute/path/envcheck-workbench-0.2.0-alpha.1.tgz
./node_modules/.bin/envcheck --help
./node_modules/.bin/envcheck init .
./node_modules/.bin/envcheck scan . --json
```

Node: ^22.18.0 lub >=24.11.0. Zależności nie są dołączone do tarballa: instalacja wymaga rejestru lub kompletnego cache. Nie używaj npx envcheck ani instalacji z katalogu checkoutu. Szczegóły: [instalacja](docs/installation.md).

## Skan i naprawy

Konfiguracja musi mieć version: 1, jawny zakres sources i co najwyżej jedną usługę compose. [Konfiguracja](docs/configuration.md) opisuje variables, required, ignore oraz warunki.

Wywołuj lokalny bin: explain DATABASE_URL ., plan ., fix-example . i fix-compose . . Naprawy domyślnie są podglądem; --apply zapisuje wyłącznie obsługiwane deklaracje. Obejrzyj rzeczywisty diff i uruchom osobny scan lokalny po naprawie strukturalnej. Nie dopisuj fikcyjnych sekretów, aby uzyskać 0.

--no-values pomija lokalne envFiles konfiguracji EnvCheck, ale nadal czyta env_file wybranej usługi Compose do analizy deklaracji. Raporty pomijają wartości niezależnie od tej flagi. Unknown oznacza brak wystarczających dowodów; not-checked oznacza pominiętą kontrolę. Kod 1 to blokujące ustalenia, nie dowód awarii procesu. Kod 2 to problem wejścia/wywołania lub odmowa naprawy.

Nie uruchamia aplikacji, kontenerów ani walidacji poświadczeń. Zobacz [README](README.md), [ograniczenia](docs/limitations.md) i [Zod](docs/zod.md). CI ma osiem konfiguracji Windows/Linux; nie zostało uruchomione zdalnie dla tego eksportu. Plan kolejnych czynności jest w [planie wydania](docs/release-plan.md).
