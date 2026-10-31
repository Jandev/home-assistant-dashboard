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
    restart: unless-stopped

volumes:
  dashboard-data:
```

Zorg dat `config/dashboard.json` op de Docker-host bestaat. Haal updates op met:

```sh
docker compose pull home-assistant-dashboard
docker compose up -d home-assistant-dashboard
```
