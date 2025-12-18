# Исследование: Источники координат станций и маршрутов поездов

## Текущая ситуация

### Используемые источники данных:

1. **Open Night Train Database** (Back-on-Track)

   - Источник: `https://raw.githubusercontent.com/Back-on-Track-eu/night-train-data/main/data/latest/`
   - Данные: Только спальные поезда (night trains)
   - Станции: Ограниченный набор станций спальных поездов
   - Координаты: Включены в данные

2. **DB REST API** (v6.db.transport.rest)

   - Статус: Временно отключен из-за rate limiting
   - Возможности: Поиск станций, получение отправлений
   - Охват: Германия и частично Европа

3. **HAFAS API** (через hafas-client)
   - Статус: Работает для ÖBB (Австрия)
   - Возможности: Реальные отправления поездов
   - Ограничения: Только Австрия, требует настройки профилей для других стран

---

## Решения для координат станций

### 1. db-hafas-stations (npm package) ⭐⭐⭐ ЛУЧШИЙ ВАРИАНТ ДЛЯ DB

**Источник:** [github.com/derhuerst/db-hafas-stations](https://github.com/derhuerst/db-hafas-stations)

**Преимущества:**

- ✅ **Предобработанные данные** - готовы к использованию, не нужно делать запросы
- ✅ **~290,000 станций DB** - включает все станции и остановки общественного транспорта
- ✅ **Координаты включены** - latitude, longitude в каждом объекте
- ✅ **Компактный размер** - ~14MB упрощенный формат, ~112MB полный
- ✅ **Формат FPTF** - стандартизированный Friendly Public Transport Format
- ✅ **Актуальные данные** - получены из официальных API DB (RIS::Stations и StaDa)
- ✅ **Нет rate limiting** - данные локальные, можно использовать сколько угодно
- ✅ **Быстрая загрузка** - NDJSON формат, можно читать потоково
- ✅ **Лицензия** - ISC (код) + CC BY 4.0 (данные), разрешает коммерческое использование

**Использование:**

```javascript
import { readSimplifiedStations, readFullStations } from "db-hafas-stations";

// Упрощенный формат (~14MB) - достаточно для большинства случаев
for await (const station of readSimplifiedStations()) {
  console.log(station);
  // {
  //   type: 'station',
  //   id: '8000007',
  //   name: 'Alzey',
  //   weight: 73.1,  // Важность станции
  //   location: {
  //     type: 'location',
  //     latitude: 49.7502,
  //     longitude: 8.109749
  //   }
  // }
}

// Полный формат (~112MB) - больше метаданных
for await (const station of readFullStations()) {
  // Больше полей: address, operator, etc.
}
```

**Реализация для нашего проекта:**

```javascript
// pages/api/stations/db-hafas.js
import { readSimplifiedStations } from "db-hafas-stations";

// Кэшируем данные при первом запросе
let stationsCache = null;
let cacheTimestamp = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 часа

export default async function handler(req, res) {
  const { filter, limit } = req.query;

  // Загружаем данные один раз и кэшируем
  if (!stationsCache || Date.now() - cacheTimestamp > CACHE_DURATION) {
    const stations = [];
    for await (const station of readSimplifiedStations()) {
      stations.push({
        stop_id: station.id,
        stop_name: station.name,
        stop_lat: station.location.latitude,
        stop_lon: station.location.longitude,
        weight: station.weight, // Можно использовать для фильтрации важных станций
        source: "db-hafas-stations",
      });
    }
    stationsCache = stations;
    cacheTimestamp = Date.now();
  }

  let result = stationsCache;

  // Фильтрация по важности (weight) если нужно
  if (filter === "major") {
    result = result.filter((s) => s.weight > 50); // Только важные станции
  }

  // Лимит результатов
  if (limit) {
    result = result.slice(0, parseInt(limit));
  }

  res.setHeader("Cache-Control", "public, max-age=86400"); // 24 часа
  return res.status(200).json({
    stations: result,
    count: result.length,
    total: stationsCache.length,
  });
}
```

**Ограничения:**

- ⚠️ Только для станций DB (Германия и частично Европа)
- ⚠️ Не включает маршруты, только станции
- ⚠️ Нужно установить npm пакет (~14MB данных)

**Рекомендация:** Использовать как основной источник для станций DB, комбинировать с Overpass API для других стран.

---

### 2. Overpass API (OpenStreetMap) ⭐ РЕКОМЕНДУЕТСЯ ДЛЯ ДРУГИХ СТРАН

**Преимущества:**

- Бесплатный и открытый
- Огромная база данных станций по всему миру
- Включает координаты и метаданные
- Нет rate limiting для разумного использования
- Поддерживает сложные запросы

**Пример запроса для получения всех железнодорожных станций в регионе:**

```javascript
// API endpoint: https://overpass-api.de/api/interpreter
// или https://overpass.kumi.systems/api/interpreter

const overpassQuery = `
[out:json][timeout:25];
(
  // Железнодорожные станции
  node["railway"="station"]({{bbox}});
  node["public_transport"="station"]["railway"~"^(station|halt)$"]({{bbox}});
  // Остановки поездов
  node["railway"="halt"]({{bbox}});
  // Платформы
  way["railway"="platform"]({{bbox}});
);
out body;
>;
out skel qt;
`;

// Для конкретного региона (bbox = min_lat,min_lon,max_lat,max_lon)
// Например, для Германии: [47.0, 5.0, 55.0, 15.0]
```

**Реализация:**

```javascript
// pages/api/stations/overpass.js
export default async function handler(req, res) {
  const { bbox, country } = req.query;

  // Bbox по умолчанию для Европы
  const defaultBbox = "47.0,5.0,55.0,15.0"; // Центральная Европа

  const query = `
[out:json][timeout:25];
(
  node["railway"="station"](${bbox || defaultBbox});
  node["public_transport"="station"]["railway"~"^(station|halt)$"](${bbox || defaultBbox});
  node["railway"="halt"](${bbox || defaultBbox});
);
out body;
>;
out skel qt;
`;

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: query
    });

    const data = await response.json();

    // Преобразуем в наш формат
    const stations = data.elements
      .filter(el => el.type === 'node' && el.lat && el.lon)
      .map(el => ({
        stop_id: el.id.toString(),
        stop_name: el.tags?.name || el.tags?.name:en || 'Unknown',
        stop_lat: el.lat,
        stop_lon: el.lon,
        source: 'openstreetmap',
        tags: el.tags
      }));

    return res.status(200).json({ stations, count: stations.length });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
```

**Ограничения:**

- Может быть медленным для больших регионов
- Нужно кэшировать результаты
- Требует обработки разных форматов названий

---

### 3. Nominatim API (Geocoding для OpenStreetMap)

**Использование:** Поиск станций по названию и получение координат

```javascript
// Пример поиска станции
const searchStation = async (stationName) => {
  const url =
    `https://nominatim.openstreetmap.org/search?` +
    `q=${encodeURIComponent(stationName + " railway station")}` +
    `&format=json&limit=1&addressdetails=1`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "train-map-app/1.0",
      "Accept-Language": "en,de,fr",
    },
  });

  return await response.json();
};
```

**Ограничения:**

- Rate limit: 1 запрос в секунду
- Требует User-Agent
- Может возвращать неточные результаты

---

### 4. DB REST API (когда доступен)

**Endpoint:** `https://v6.db.transport.rest/locations`

```javascript
// Уже реализовано в /api/stations.js
// Можно использовать для получения координат станций Германии
```

---

## Решения для маршрутов всех поездов (не только спальных)

### 1. HAFAS API с фильтрацией по типам поездов ⭐ РЕКОМЕНДУЕТСЯ

**Текущая реализация:** Используется только для получения отправлений

**Расширение:** Можно получать маршруты всех типов поездов

```javascript
// В hafas-client можно фильтровать по типам поездов
import { createClient } from "hafas-client";
import { profile as dbProfile } from "hafas-client/p/db/index.js";

const client = createClient(dbProfile, "train-map-app");

// Получить все отправления (все типы поездов)
const departures = await client.departures(stationId, {
  duration: 120, // 2 часа
  results: 50,
  // Не фильтруем по типу - получаем все
});

// Типы поездов в HAFAS:
// - ICE (InterCity Express)
// - IC (InterCity)
// - EC (EuroCity)
// - RE (Regional Express)
// - RB (Regional Bahn)
// - S-Bahn
// - и другие
```

**Проблема:** DB HAFAS API отключен, но можно использовать:

- ÖBB (Австрия) - работает
- SNCF (Франция) - через hafas-client/p/sncf
- SBB (Швейцария) - через hafas-client/p/sbb
- И другие профили

**Полезный ресурс:** [transport-apis каталог](https://github.com/public-transport/transport-apis) содержит список всех доступных HAFAS endpoints с информацией о покрытии, протоколах и лицензиях. Можно использовать для автоматического поиска доступных API для конкретных стран и регионов.

**Реализация для получения маршрутов:**

```javascript
// Получить маршрут поезда между станциями
const journey = await client.journeys(fromStation, toStation, {
  results: 1,
  transfers: 0, // Прямой маршрут
});

// journey содержит:
// - segments с координатами маршрута
// - stops с остановками
// - можно построить полилинию на карте
```

---

### 2. DB REST API - Journeys endpoint

**Endpoint:** `https://v6.db.transport.rest/journeys`

```javascript
// Получить маршруты между станциями
const getRoute = async (from, to) => {
  const url =
    `https://v6.db.transport.rest/journeys?` +
    `from=${encodeURIComponent(from)}` +
    `&to=${encodeURIComponent(to)}` +
    `&results=1`;

  const response = await fetch(url);
  return await response.json();
};

// Ответ содержит:
// - trips с сегментами маршрута
// - можно извлечь координаты для отображения на карте
```

**Ограничения:**

- Требует две станции (не показывает все маршруты из одной станции)
- Rate limiting
- Только Германия

---

### 3. OpenRailwayMap + Overpass API

**Идея:** Получить железнодорожные линии из OpenStreetMap

```javascript
// Запрос для получения железнодорожных линий
const railwayLinesQuery = `
[out:json][timeout:25];
(
  way["railway"~"^(rail|light_rail|subway|tram)$"]({{bbox}});
);
out geom;
`;

// Это даст нам линии, но не маршруты конкретных поездов
// Полезно для отображения инфраструктуры
```

**Ограничения:**

- Показывает инфраструктуру, а не маршруты поездов
- Не содержит информацию о расписании
- Большие объемы данных

---

### 4. GTFS (если оптимизировать)

**Проблема:** Медленная загрузка больших файлов

**Решение:** Использовать только необходимые данные

- Загружать только routes.txt и stops.txt (без stop_times.txt)
- Использовать предобработанные данные
- Кэшировать агрессивно

**Альтернатива:** Использовать GTFS-RT (real-time) для конкретных маршрутов

---

## Рекомендуемый подход

### Для координат станций:

1. **Основной источник для DB:** db-hafas-stations (npm package) ⭐

   - Предобработанные данные ~290k станций
   - Включает координаты и метаданные
   - Быстрая загрузка, нет rate limiting
   - Идеально для Германии и станций DB

2. **Для других стран:** Overpass API (OpenStreetMap)

   - Получать станции по регионам
   - Кэшировать результаты
   - Использовать для Австрии, Швейцарии, Франции и др.

3. **Резервный источник:** Nominatim API

   - Для поиска конкретных станций по названию
   - Когда другие источники не дают результатов

### Для маршрутов всех поездов:

1. **Основной подход:** Расширить использование HAFAS API

   - Использовать `departures()` для получения всех типов поездов
   - Использовать `journeys()` для построения маршрутов между станциями
   - Фильтровать по типам поездов (ICE, IC, RE, RB и т.д.)

2. **Визуализация маршрутов:**

   - При клике на станцию: показывать маршруты всех отправляющихся поездов
   - Использовать данные из `departures` для построения путей
   - Комбинировать с координатами станций из HAFAS или Overpass

3. **Альтернатива:** DB REST API journeys
   - Когда доступен, использовать для получения маршрутов
   - Кэшировать популярные маршруты

---

## Конкретная реализация

### Шаг 1: Получение координат станций через Overpass

```javascript
// pages/api/stations/overpass.js
export default async function handler(req, res) {
  const { bbox, country } = req.query;

  // Bbox для разных регионов
  const bboxes = {
    germany: "47.0,5.0,55.0,15.0",
    austria: "46.0,9.0,49.0,17.0",
    switzerland: "45.0,5.0,48.0,11.0",
    france: "41.0,-5.0,51.0,10.0",
    europe: "35.0,-10.0,72.0,40.0",
  };

  const selectedBbox = bbox || bboxes[country] || bboxes.europe;

  const query = `
[out:json][timeout:25];
(
  node["railway"="station"](${selectedBbox});
  node["public_transport"="station"]["railway"~"^(station|halt)$"](${selectedBbox});
);
out body;
>;
out skel qt;
`;

  try {
    const response = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: query,
    });

    const data = await response.json();

    const stations = data.elements
      .filter((el) => el.type === "node" && el.lat && el.lon)
      .map((el) => ({
        stop_id: el.id.toString(),
        stop_name: el.tags?.name || el.tags?.["name:en"] || "Unknown",
        stop_lat: el.lat,
        stop_lon: el.lon,
        source: "openstreetmap",
        railway_type: el.tags?.railway || "station",
      }));

    res.setHeader("Cache-Control", "public, max-age=86400"); // 24 часа
    return res.status(200).json({ stations, count: stations.length });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
```

### Шаг 2: Расширение HAFAS для всех типов поездов

```javascript
// В pages/api/departures.js добавить поддержку всех типов поездов

// Получить все отправления без фильтрации
const getAllDepartures = async (stationId, when, duration) => {
  const departures = await oebbClient.departures(stationId, {
    when: when,
    duration: duration,
    results: 100, // Больше результатов
    // Не фильтруем по типу поезда
  });

  return departures;
};

// Группировать по типам поездов
const groupByTrainType = (departures) => {
  const groups = {
    ICE: [],
    IC: [],
    EC: [],
    RE: [],
    RB: [],
    S: [],
    other: [],
  };

  departures.forEach((dep) => {
    const product = dep.line?.product || "other";
    if (groups[product]) {
      groups[product].push(dep);
    } else {
      groups.other.push(dep);
    }
  });

  return groups;
};
```

### Шаг 3: Построение маршрутов из отправлений

```javascript
// Получить маршрут поезда
const getTrainRoute = async (departure) => {
  // Используем journey для получения полного маршрута
  const journey = await client.journeys(
    departure.stop.id,
    departure.destination.id,
    {
      departure: departure.when,
      results: 1,
    },
  );

  if (journey.journeys && journey.journeys.length > 0) {
    const trip = journey.journeys[0];
    // Извлечь координаты остановок
    const coordinates = trip.legs
      .flatMap((leg) => leg.stopovers || [])
      .map((stopover) => [
        stopover.stop.location.latitude,
        stopover.stop.location.longitude,
      ]);

    return coordinates;
  }

  return null;
};
```

---

## Итоговые рекомендации

### Приоритет 1: db-hafas-stations для станций DB

- ✅ Предобработанные данные, готовы к использованию
- ✅ ~290k станций с координатами
- ✅ Быстрая загрузка, нет rate limiting
- ✅ Формат FPTF, легко интегрировать
- ⚠️ Только для станций DB (Германия)

### Приоритет 1.5: Overpass API для других стран

- ✅ Бесплатный и надежный
- ✅ Большая база данных по всему миру
- ✅ Включает координаты
- ⚠️ Требует кэширования

### Приоритет 2: Расширение HAFAS API

- ✅ Уже используется для ÖBB
- ✅ Поддерживает все типы поездов
- ✅ Реальные данные в реальном времени
- ⚠️ Ограничен по странам (нужны профили)

### Приоритет 3: Комбинированный подход

- Использовать **db-hafas-stations** для станций DB (Германия)
- Использовать **Overpass API** для станций других стран
- Использовать **HAFAS** для маршрутов и отправлений
- Использовать **transport-apis каталог** для поиска альтернативных API
- Объединять данные для полной картины

---

## Полезные ресурсы для поиска API

### transport-apis (public-transport) ⭐ КАТАЛОГ API

**Источник:** [github.com/public-transport/transport-apis](https://github.com/public-transport/transport-apis)

**Что это:**

- Машиночитаемый каталог публичных транспортных API endpoints
- Более 80 операторов по всему миру
- Информация о протоколах, покрытии, лицензиях, языках

**Поддерживаемые протоколы:**

- `hafasMgate` - HAFAS mgate.exe (используется многими европейскими операторами)
- `hafasQuery` - HAFAS query.exe
- `efa` - EFA (Elektronische Fahrplanauskunft)
- `navitia` - Navitia API
- `otpGraphQl` / `otpRest` - Open Trip Planner
- `trias` - TRIAS стандарт
- `motis` - MOTIS

**Полезность для проекта:**

1. **Поиск альтернативных API для разных стран:**

   - Найти HAFAS endpoints для других европейских стран
   - Найти API с хорошим покрытием для конкретных регионов
   - Узнать какие протоколы поддерживаются

2. **Информация о покрытии:**

   - `realtimeCoverage` - где доступны данные в реальном времени
   - `regularCoverage` - где доступны полные данные
   - `anyCoverage` - где доступны базовые данные

3. **Лицензионная информация:**
   - Какие API открытые (Open Data)
   - Какие требуют регистрации/ключей
   - Требования к атрибуции

**Пример использования:**

```javascript
// Можно использовать данные из transport-apis для автоматического
// поиска доступных API для конкретной страны/региона

// Например, найти все HAFAS endpoints для Германии:
const germanyHafasApis = transportApis.filter(
  (api) =>
    api.type.hafasMgate && api.coverage.regularCoverage?.region?.includes("DE"),
);
```

**Ограничения:**

- ⚠️ Данные зависят от обновлений сообщества
- ⚠️ Некоторые API могут требовать регистрации
- ⚠️ Не все API бесплатные

**Рекомендация:** Использовать как справочник для поиска альтернативных API, особенно для стран, где DB REST API недоступен.

---

## Следующие шаги

1. **Установить и интегрировать db-hafas-stations** для станций DB

   - `npm install db-hafas-stations`
   - Создать API endpoint для получения станций
   - Кэшировать данные на сервере

2. **Использовать transport-apis каталог** для поиска альтернативных API

   - Найти HAFAS endpoints для других стран Европы
   - Интегрировать дополнительные источники данных

3. Реализовать Overpass API endpoint для станций других стран
4. Расширить HAFAS API для получения всех типов поездов
5. Добавить фильтрацию по типам поездов в UI
6. Реализовать построение маршрутов из данных HAFAS
7. Оптимизировать кэширование для быстрой работы
