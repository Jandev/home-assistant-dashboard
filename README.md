# Home Assistant Dashboard

Een tabletvriendelijk dashboard voor Home Assistant met pagina’s voor energie, kamers, agenda, muziek en camera’s.

## Lokaal starten

Vereist Node.js 22 of nieuwer. Maak eerst een eigen configuratiebestand aan:

```sh
cp config/dashboard.example.json config/dashboard.json
cp .env.example .env
```

Vul daarna in `config/dashboard.json` de entiteiten van je eigen Home Assistant in en zet de URL, toegangstoken en eventuele afvalkalenderidentifier in `.env`. Deze bestanden zijn uitgesloten van versiebeheer.

```sh
npm ci
npm run build
npm start
```

Open `http://localhost:8080`. Ontwikkelen kan met `npm run dev`. De optionele browsercontrole vereist Playwright; zie `npm run test:browser`.

Met `npm start` of `npm run dev` gebruikt de screensaver automatisch de map `photos/` in de repository. In Docker blijft de geconfigureerde map `/app/photos`, gekoppeld aan `./photos` op de host.

Voor lokale beeldconversie moeten `ffmpeg` en `heif-convert` beschikbaar zijn in `PATH`; de Docker-image bevat beide hulpprogramma’s. Als een benodigde converter ontbreekt, geeft de foto-endpoint nu aan welke executable ontbreekt.

De VS Code-taak `Lokaal: starten en testen` bouwt en start de Docker Compose-container op `http://localhost:8090`; stop de voorgrondtaak met Ctrl+C. In de devcontainer moet Docker-toegang eenmalig worden geïnstalleerd via **Dev Containers: Rebuild Container**. Rechtstreeks `docker compose up` gebruikt ook hostpoort 8090.

## Instellingen

`.env.example` beschrijft de beschikbare omgevingsvariabelen. Gebruik een Home Assistant-weather-entiteit of vul `WEATHER_LATITUDE` en `WEATHER_LONGITUDE` in voor Open-Meteo. Stel in de configuratie onder meer agenda, snelle acties, speakers, camera’s en energiemeters in. Zie [config/dashboard.example.json](config/dashboard.example.json) voor de structuur.

De dashboard-URL heeft geen eigen login. Gebruik de toepassing daarom alleen op een vertrouwd netwerk of achter een passende VPN of beveiligde proxy.

## Container gebruiken

De GitHub Actions-workflow bouwt en publiceert bij een push naar `main` een containerimage op:

```text
ghcr.io/jandev/home-assistant-dashboard:latest
```

Maak op de Docker-host een eigen configuratie en `.env` aan; zet nooit tokens of installatiegegevens in de repository. Voor een bestaand Compose-project kun je deze service gebruiken:

```yaml
services:
  home-assistant-dashboard:
    image: ghcr.io/jandev/home-assistant-dashboard:latest
    user: "${PUID:-1000}:${PGID:-1000}"
    environment:
      HOMEASSISTANT_URL: ${HOMEASSISTANT_URL:?Stel HOMEASSISTANT_URL in}
      HOMEASSISTANT_API_KEY: ${HOMEASSISTANT_API_KEY:?Stel HOMEASSISTANT_API_KEY in}
      AFVALKALENDER_ADRESS: ${AFVALKALENDER_ADRESS:-}
      WEATHER_LATITUDE: ${WEATHER_LATITUDE:-}
      WEATHER_LONGITUDE: ${WEATHER_LONGITUDE:-}
      TZ: Europe/Amsterdam
    ports:
      - "8090:8080"
    volumes:
      - dashboard-data:/app/data
      - ./config/dashboard.json:/app/config/dashboard.json:ro
      - ./photos:/app/photos:ro
    restart: unless-stopped

volumes:
  dashboard-data:
```

Maak naast `config/` een map `photos/` op de Docker-host en plaats daar de foto’s in (submappen worden ook doorzocht). De map wordt read-only gekoppeld. JPEG-, PNG- en HEIC-bestanden worden door de container naar maximaal 1920×1200 JPEG’s geconverteerd, met EXIF-oriëntatie toegepast. De cache staat in `dashboard-data` en de originele foto’s blijven ongewijzigd. Zet in `config/dashboard.json` de instellingen onder `screensaver`; [config/dashboard.example.json](config/dashboard.example.json) bevat de volledige standaardinstelling. De fotoscreensaver start na 120 seconden zonder invoer en wisselt standaard elke 15 seconden van foto. De klok, datum en weersinformatie verplaatsen iedere minuut naar een andere schermhoek.

De nachtperiode is standaard 23:00–07:00 in `Europe/Amsterdam`. In Fully Kiosk Browser gebruikt het dashboard `fully.turnScreenOff()` en `fully.turnScreenOn()` als die JavaScript-interface beschikbaar is; configureer Fully daarnaast om aanraking het scherm te laten wekken. In andere browsers toont het dashboard een zwart scherm. ’s Nachts aanraken toont het dashboard twee minuten, waarna het nachtscherm terugkeert. Overdag sluit aanraken de fotoscreensaver en blijft de huidige dashboardpagina staan.

### Screensaver op Synology controleren

Bekijk de servermeldingen met `docker logs --tail 100 dashboard`. Screensaverfouten vermelden de stap (`photo-directory-read`, `photo-stat`, `heic-convert`, `ffmpeg` of `cache-read`) en foutcode, zonder fotopaden of bestandsnamen te loggen. `EACCES` betekent dat de containergebruiker geen toegang heeft tot de fotomap, een bovenliggende map of het cachevolume. `No supported photos found` betekent dat de gekoppelde map leeg is, niet bestaat of geen ondersteunde foto’s bevat.

Compose start de container als de numerieke gebruiker en groep uit `PUID` en `PGID` (standaard `1000:1000`). Je hoeft dus geen account met de naam `node` op Synology aan te maken. Zet de IDs in het `.env`-bestand naast `compose.yaml`; haal ze op met `id <DSM-gebruikersnaam>`. Alleen `PUID` en `PGID` onder de Compose-sectie `environment:` zetten verandert de uitvoergebruiker niet.

Controleer dat de hostmap in Compose naar de map met foto’s wijst en op `/app/photos` is gekoppeld. De ingestelde UID/GID moet de mappen kunnen doorlopen en de fotobestanden kunnen lezen; read-only (`:ro`) is geschikt. Dezelfde UID/GID moet schrijfrechten hebben op het bestaande `dashboard-data`-volume dat aan `/app/data` hangt. Na het wijzigen van PUID/PGID kan het nodig zijn de eigenaar van dat volume aan te passen.

Zorg dat `config/dashboard.json` op de Docker-host bestaat. Haal updates op met:

```sh
docker compose pull home-assistant-dashboard
docker compose up -d home-assistant-dashboard
```

## Huis aanpassen

Met `house` in `config/dashboard.json` kun je kamers (`excludeRooms`, gebied-ID’s) en oude lampen (`excludeEntities`, entiteit-ID’s) verbergen. Via `roomEntities` voeg je specifieke stekkers en scènes aan een kamer toe; alleen deze stekkers krijgen bediening. `lightGroups` bundelt lampen tot één dashboardknop met een gezamenlijke dimmer en kleurkiezer (als alle lampen kleur ondersteunen). Zie de voorbeeldconfiguratie voor de structuur.

De groepering geldt voor opdrachten vanuit dit dashboard. Voor synchronisatie bij bediening via andere apps of fysieke schakelaars is ook een groep/automatisering in Home Assistant nodig. De eigen configuratie is niet opgenomen in Git; neem deze bij uitrollen apart over op de Docker-host.
