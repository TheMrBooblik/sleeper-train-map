import 'dart:ui' show Color;

import 'package:latlong2/latlong.dart';

import '../logic/thinning.dart';
import 'polyline_codec.dart';

/// The payload models.
///
/// Everything here is decoded straight from `mobile-v1.json`, which the nightly
/// job builds by running the web map's own render modules
/// (`scripts/build-mobile-payload.mjs`). Nothing in this file re-derives a
/// styling or routing decision — if a value looks like it needs computing,
/// it should be computed in that script instead, or the two implementations
/// will drift.
///
/// The one deliberate exception is anything that depends on *today*: the payload
/// carries `seasonRanges` and `futureStarts` rather than the verdicts derived
/// from them, because a seed copy shipped in the store can be months old. See
/// `logic/season.dart`.

class Stop {
  const Stop(this.name, this.arrival, this.departure);

  final String name;

  /// Either an ISO instant or a wall-clock `HH:MM`, depending on the owning
  /// [Schedule]'s [Schedule.tz]. Never format these directly — go through
  /// `logic/time_format.dart`, which is what keeps a Nightjet departure from
  /// being shown two hours out.
  final String? arrival;
  final String? departure;

  static Stop fromJson(List<dynamic> json) =>
      Stop(json[0] as String, json[1] as String?, json[2] as String?);
}

/// How a schedule's times must be read.
enum TimeZoneKind {
  /// Real instants ("2026-08-31T17:06:00.000Z") — localise before display.
  utc,

  /// Wall clock already in the station's own local time — show verbatim.
  wall,
}

class Schedule {
  const Schedule({
    required this.source,
    required this.tz,
    required this.stops,
    this.days,
  });

  /// Which operator feed won the precedence chain (`pkp`, `nightjet`, `cd`, …).
  final String source;
  final TimeZoneKind tz;
  final List<Stop> stops;
  final String? days;

  static Schedule? fromJson(Map<String, dynamic>? json) {
    if (json == null) return null;
    final stops = (json['stops'] as List<dynamic>? ?? [])
        .map((s) => Stop.fromJson(s as List<dynamic>))
        .toList();
    if (stops.isEmpty) return null;
    return Schedule(
      source: json['src'] as String? ?? 'unknown',
      tz: json['tz'] == 'utc' ? TimeZoneKind.utc : TimeZoneKind.wall,
      stops: stops,
      days: json['days'] as String?,
    );
  }
}

class Amenities {
  const Amenities({
    this.catering,
    this.plugs,
    this.wheelchair,
    this.bikes,
    this.car,
  });

  final Object? catering;
  final Object? plugs;
  final Object? wheelchair;
  final Object? bikes;
  final Object? car;

  static Amenities? fromJson(Map<String, dynamic>? json) => json == null
      ? null
      : Amenities(
          catering: json['catering'],
          plugs: json['plugs'],
          wheelchair: json['wheelchair'],
          bikes: json['bikes'],
          car: json['car'],
        );
}

/// One direction of a route: the card the detail sheet renders.
class RouteDirection {
  const RouteDirection({
    required this.direction,
    required this.from,
    required this.to,
    this.train,
    this.departure,
    this.arrival,
    this.service,
    this.via = const [],
    this.irregularities,
    this.duration,
    this.distance,
    this.co2,
    this.classes,
    this.amenities,
    this.bookingUrl,
    this.schedule,
    this.cdSchedule,
  });

  final int direction;
  final String from;
  final String to;
  final String? train;
  final String? departure;
  final String? arrival;

  /// Already in the display form the web renders ("2026: Daily").
  final String? service;
  final List<String> via;
  final String? irregularities;
  final String? duration;
  final Object? distance;
  final Object? co2;
  final String? classes;
  final Amenities? amenities;

  /// The operator's booking URL with origin/destination already filled in —
  /// the template lives in `data/overrides/operator-booking.json` and is
  /// resolved at build time, so the app carries no URL-building code.
  final String? bookingUrl;

  final Schedule? schedule;

  /// A ČD EuroNight can carry a second timetable, which the web shows as its
  /// own accordion rather than as a replacement.
  final Schedule? cdSchedule;

  static RouteDirection fromJson(Map<String, dynamic> json) => RouteDirection(
        direction: json['d'] as int? ?? 0,
        from: json['from'] as String? ?? '',
        to: json['to'] as String? ?? '',
        train: json['train'] as String?,
        departure: json['dep'] as String?,
        arrival: json['arr'] as String?,
        service: json['service'] as String?,
        via: (json['via'] as List<dynamic>? ?? []).cast<String>(),
        irregularities: json['irregularities'] as String?,
        duration: json['duration'] as String?,
        distance: json['distance'],
        co2: json['co2'],
        classes: json['classes'] as String?,
        amenities: Amenities.fromJson(json['amenities'] as Map<String, dynamic>?),
        bookingUrl: json['booking'] as String?,
        schedule: Schedule.fromJson(json['schedule'] as Map<String, dynamic>?),
        cdSchedule:
            Schedule.fromJson(json['cdSchedule'] as Map<String, dynamic>?),
      );
}

/// An operator's promotions link. `getDealsLink` returns a `{url, label}` pair,
/// not a bare URL — the label is operator-written ("Last-minute deals") and is
/// what the button should say.
class DealsLink {
  const DealsLink({required this.url, this.label});

  final String url;
  final String? label;

  static DealsLink? fromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final url = json['url'];
    if (url is! String || url.isEmpty) return null;
    return DealsLink(url: url, label: json['label'] as String?);
  }
}

/// One drawn stroke. A route is usually one, but a return leg that genuinely
/// leaves the outbound corridor adds its own, and PKP adds bus connectors.
class RouteStroke {
  const RouteStroke({required this.points, required this.isBus});

  final List<LatLng> points;
  final bool isBus;
}

class TrainRoute {
  TrainRoute({
    required this.id,
    required this.agency,
    required this.color,
    required this.weight,
    required this.opacity,
    required this.ghostOpacity,
    required this.dash,
    required this.strokes,
    required this.directions,
    required this.seasonRanges,
    required this.seasonBounded,
    required this.futureStarts,
    required this.hasUnknownStart,
    required this.drawAsActive,
    this.picture,
    this.pricing,
    this.deals,
  });

  final String id;
  final String agency;

  /// Baked once over the full route set. The web shades by an operator's
  /// *visible* route count, so a route changes shade when a station is
  /// selected; here it keeps one colour across every view.
  final Color color;
  final double weight;

  /// The BASE opacity — never the future-ghost one. The web folds the ghost
  /// into its style at render time, which is a statement about today; the app
  /// applies it itself in `logic/season.dart`.
  final double opacity;

  /// What to substitute once the app decides a route has not opened yet.
  /// Carried rather than hardcoded so the legend and the map cannot drift.
  final double ghostOpacity;

  /// Dash segments in Flutter's units, already numeric — the web stores
  /// Leaflet's `"10,5"` string. The dash is the cadence signal: solid = daily,
  /// longer dashes = less often.
  final List<double>? dash;

  final List<RouteStroke> strokes;
  final List<RouteDirection> directions;

  /// `[[startISO, endISO], …]` — the service windows the trips declare.
  final List<List<String>> seasonRanges;

  /// True when *every* trip declares a window. A route is only hidden out of
  /// season when that holds and all windows have passed.
  final bool seasonBounded;

  /// Candidate opening dates, unfiltered by today.
  final List<String> futureStarts;

  /// Announced but with no date at all ("postponed to 2027") — drawn thin.
  final bool hasUnknownStart;

  /// Tickets already on sale: keep full opacity even before the start date.
  final bool drawAsActive;

  final String? picture;
  final Object? pricing;
  final DealsLink? deals;

  static TrainRoute fromJson(Map<String, dynamic> json) {
    final strokes = <RouteStroke>[];
    for (final g in json['geom'] as List<dynamic>? ?? []) {
      final map = g as Map<String, dynamic>;
      final points = decodePolyline(map['p'] as String);
      if (points.length < 2) continue;
      strokes.add(RouteStroke(points: points, isBus: map['bus'] == true));
    }

    return TrainRoute(
      id: json['id'] as String,
      agency: json['agency'] as String? ?? '',
      color: _parseHexColor(json['color'] as String?),
      weight: (json['weight'] as num?)?.toDouble() ?? 4.5,
      opacity: (json['opacity'] as num?)?.toDouble() ?? 0.92,
      ghostOpacity: (json['ghostOpacity'] as num?)?.toDouble() ?? 0.35,
      dash: (json['dash'] as List<dynamic>?)
          ?.map((n) => (n as num).toDouble())
          .toList(),
      strokes: strokes,
      directions: (json['dirs'] as List<dynamic>? ?? [])
          .map((d) => RouteDirection.fromJson(d as Map<String, dynamic>))
          .toList(),
      seasonRanges: (json['seasonRanges'] as List<dynamic>? ?? [])
          .map((r) => (r as List<dynamic>).cast<String>())
          .toList(),
      seasonBounded: json['seasonBounded'] == true,
      futureStarts: (json['futureStarts'] as List<dynamic>? ?? []).cast<String>(),
      hasUnknownStart: json['hasUnknownStart'] == true,
      drawAsActive: json['drawAsActive'] == true,
      picture: json['picture'] as String?,
      pricing: json['pricing'],
      deals: DealsLink.fromJson(json['deals']),
    );
  }

  String get label {
    if (directions.isEmpty) return id;
    final d = directions.first;
    return '${d.from} → ${d.to}';
  }
}

class Station implements Thinnable {
  const Station({
    required this.name,
    required this.position,
    required this.routeIds,
    required this.isMain,
    this.alwaysShow = false,
  });

  final String name;
  final LatLng position;
  final List<String> routeIds;

  /// An endpoint of at least one route, rather than only a via-stop. Drives
  /// marker prominence and the viewport thinning score.
  final bool isMain;

  /// Survives viewport thinning at any zoom. Resolved at build time, because
  /// the web matches its allowlist through `normalizeStationNameForLookup` —
  /// 50 lines of Belgian hyphen and Czech suffix rewrites that would otherwise
  /// need a Dart copy kept in step for the sake of one boolean.
  @override
  final bool alwaysShow;

  @override
  double get lat => position.latitude;

  @override
  double get lng => position.longitude;

  /// Endpoints outrank via-stops by a wide margin, then more routes wins —
  /// `getStationScore` in thinStationsByViewport.js.
  @override
  int get thinningScore => (isMain ? 1000 : 0) + routeIds.length;

  static Station fromJson(Map<String, dynamic> json) => Station(
        name: json['n'] as String,
        position: LatLng((json['y'] as num).toDouble(), (json['x'] as num).toDouble()),
        routeIds: (json['r'] as List<dynamic>? ?? []).cast<String>(),
        isMain: json['m'] == 1,
        alwaysShow: json['a'] == 1,
      );
}

/// A city's stations collapsed to one marker, precomputed by `groupCityMarkers`
/// so the app does not carry the 60 km union-find clustering.
class CityGroup implements Thinnable {
  const CityGroup({
    required this.name,
    required this.position,
    required this.stationIndices,
    required this.isGrouped,
    this.alwaysShow = false,
  });

  final String name;
  final LatLng position;
  final List<int> stationIndices;

  /// False when the "group" is a lone station that simply got a city name.
  final bool isGrouped;

  /// True when any member station is on the always-show allowlist.
  @override
  final bool alwaysShow;

  @override
  double get lat => position.latitude;

  @override
  double get lng => position.longitude;

  /// A city marker is worth as much as the stations behind it.
  @override
  int get thinningScore => 1000 + stationIndices.length;

  static CityGroup fromJson(Map<String, dynamic> json) => CityGroup(
        name: json['n'] as String,
        position: LatLng((json['y'] as num).toDouble(), (json['x'] as num).toDouble()),
        stationIndices: (json['s'] as List<dynamic>? ?? []).cast<int>(),
        isGrouped: json['m'] == 1,
        alwaysShow: json['a'] == 1,
      );
}

class MapPayload {
  MapPayload({
    required this.version,
    required this.generatedAt,
    required this.routes,
    required this.stations,
    required this.groups,
  }) : routesById = {for (final r in routes) r.id: r};

  final int version;
  final DateTime? generatedAt;
  final List<TrainRoute> routes;
  final List<Station> stations;
  final List<CityGroup> groups;

  final Map<String, TrainRoute> routesById;

  static MapPayload fromJson(Map<String, dynamic> json) => MapPayload(
        version: json['v'] as int? ?? 1,
        generatedAt: DateTime.tryParse(json['generatedAt'] as String? ?? ''),
        routes: (json['routes'] as List<dynamic>? ?? [])
            .map((r) => TrainRoute.fromJson(r as Map<String, dynamic>))
            .toList(),
        stations: (json['stations'] as List<dynamic>? ?? [])
            .map((s) => Station.fromJson(s as Map<String, dynamic>))
            .toList(),
        groups: (json['groups'] as List<dynamic>? ?? [])
            .map((g) => CityGroup.fromJson(g as Map<String, dynamic>))
            .toList(),
      );
}

Color _parseHexColor(String? hex) {
  if (hex == null || hex.length < 7) return const Color(0xFF7A7A7A);
  final value = int.tryParse(hex.substring(1), radix: 16);
  return value == null ? const Color(0xFF7A7A7A) : Color(0xFF000000 | value);
}
