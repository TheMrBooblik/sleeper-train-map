import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import '../data/basemap.dart';
import '../data/models.dart';
import '../data/preferences.dart';
import '../data/repository.dart';
import '../logic/season.dart';
import '../logic/thinning.dart';
import '../theme.dart';
import 'nearby_sheet.dart';
import 'route_sheet.dart';
import 'route_strip.dart';
import 'search_sheet.dart';

/// The map. Everything else in the app hangs off a tap on this screen.
///
/// The heavy lifting already happened in `scripts/build-mobile-payload.mjs`:
/// geometry is decoded from one asset, styling arrives per route, and city
/// grouping is precomputed for both toggle states. What is left here is genuinely
/// interactive — what fits on screen, what is selected, and what the clock says.
class MapScreen extends StatefulWidget {
  const MapScreen({super.key});

  @override
  State<MapScreen> createState() => _MapScreenState();
}

class _MapScreenState extends State<MapScreen> {
  /// The web's default view, so the two open on the same picture of Europe.
  static const LatLng _defaultCenter = LatLng(49.385541, 12.765493);
  static const double _defaultZoom = 5;

  final MapController _map = MapController();
  final DataRepository _repository = DataRepository();

  MapPayload? _payload;
  Basemap? _basemap;
  MapPreferences _prefs = const MapPreferences();
  Object? _loadError;

  double _zoom = _defaultZoom;
  LatLngBounds? _bounds;

  Station? _selectedStation;
  CityGroup? _selectedGroup;
  TrainRoute? _selectedRoute;

  /// Recomputed only when the payload or the clock's day could have changed —
  /// season verdicts are per-route and cheap, but not per-frame cheap.
  Map<String, RouteVisibility> _visibility = const {};

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    try {
      final results = await Future.wait([
        _repository.loadLocal(),
        _repository.loadBasemap(),
        MapPreferences.load(),
      ]);
      if (!mounted) return;
      final payload = results[0] as MapPayload;
      setState(() {
        _payload = payload;
        _basemap = results[1] as Basemap;
        _prefs = results[2] as MapPreferences;
        _visibility = _evaluate(payload);
      });
    } catch (error) {
      if (mounted) setState(() => _loadError = error);
      return;
    }

    // Quietly bring the map up to date. A failure here leaves the seed or the
    // cached copy on screen, which is the whole point of loading them first.
    final fresh = await _repository.refresh();
    if (fresh != null && mounted) {
      setState(() {
        _payload = fresh;
        _visibility = _evaluate(fresh);
        _selectedStation = null;
        _selectedGroup = null;
        _selectedRoute = null;
      });
    }
  }

  Map<String, RouteVisibility> _evaluate(MapPayload payload) => {
        for (final route in payload.routes) route.id: evaluateRoute(route),
      };

  // --- selection ----------------------------------------------------------

  /// Route ids linked to whatever is selected, or null when nothing is.
  Set<String>? get _selectedRouteIds {
    if (_selectedRoute != null) return {_selectedRoute!.id};
    final station = _selectedStation;
    if (station != null) return station.routeIds.toSet();
    final group = _selectedGroup;
    final payload = _payload;
    if (group != null && payload != null) {
      return {
        for (final index in group.stationIndices)
          ...payload.stations[index].routeIds,
      };
    }
    return null;
  }

  List<TrainRoute> get _stripRoutes {
    final payload = _payload;
    final ids = _selectedRouteIds;
    if (payload == null || ids == null) return const [];
    return ids
        .map((id) => payload.routesById[id])
        .whereType<TrainRoute>()
        .where((r) => _visibility[r.id]?.visible ?? true)
        .toList()
      ..sort((a, b) => a.label.compareTo(b.label));
  }

  void _selectStation(Station station) {
    setState(() {
      _selectedStation = station;
      _selectedGroup = null;
      _selectedRoute = null;
    });
  }

  void _selectGroup(CityGroup group) {
    setState(() {
      _selectedGroup = group;
      _selectedStation = null;
      _selectedRoute = null;
    });
  }

  void _clearSelection() {
    if (_selectedStation == null &&
        _selectedGroup == null &&
        _selectedRoute == null) {
      return;
    }
    setState(() {
      _selectedStation = null;
      _selectedGroup = null;
      _selectedRoute = null;
    });
  }

  void _openRoute(TrainRoute route) {
    setState(() => _selectedRoute = route);
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => RouteSheet(route: route, visibility: _visibility[route.id]),
    );
  }

  void _goTo(LatLng target, {double zoom = 7}) {
    _map.move(target, zoom);
  }

  // --- layers -------------------------------------------------------------

  List<Polygon> _basemapPolygons(Basemap basemap, MapPalette palette) => [
        for (final polygon in basemap.countriesForZoom(_zoom))
          Polygon(
            points: polygon.outline,
            holePointsList: polygon.holes.isEmpty ? null : polygon.holes,
            color: palette.land,
            borderColor: palette.border,
            borderStrokeWidth: 0.6,
          ),
        for (final polygon in basemap.lakesForZoom(_zoom))
          Polygon(
            points: polygon.outline,
            holePointsList: polygon.holes.isEmpty ? null : polygon.holes,
            color: palette.sea,
            borderColor: palette.sea,
            borderStrokeWidth: 0.4,
          ),
      ];

  /// Which routes to draw: everything when "show routes" is on, otherwise only
  /// what the current selection touches. Season-hidden routes are never drawn.
  List<TrainRoute> get _visibleRoutes {
    final payload = _payload;
    if (payload == null) return const [];
    final ids = _selectedRouteIds;
    return payload.routes.where((route) {
      if (!(_visibility[route.id]?.visible ?? true)) return false;
      if (ids != null) return ids.contains(route.id);
      return _prefs.showRoutes;
    }).toList();
  }

  List<Polyline> _routePolylines() {
    final selectedIds = _selectedRouteIds;
    final polylines = <Polyline>[];
    for (final route in _visibleRoutes) {
      final visibility = _visibility[route.id];
      // A route the selection has singled out is drawn at full strength; the
      // rest keep the opacity their cadence and start date earned.
      final emphasised = selectedIds?.contains(route.id) ?? false;
      final opacity = emphasised ? 1.0 : (visibility?.opacity ?? route.opacity);
      final dash = route.dash;
      for (final stroke in route.strokes) {
        polylines.add(
          Polyline(
            points: stroke.points,
            color: route.color.withValues(alpha: opacity),
            strokeWidth: route.weight,
            pattern: stroke.isBus
                // A replacement bus is not a train; the web draws it broken.
                ? const StrokePattern.dotted()
                : dash == null
                    ? const StrokePattern.solid()
                    : StrokePattern.dashed(segments: dash),
          ),
        );
      }
    }
    return polylines;
  }

  List<Marker> _stationMarkers(MapPalette palette) {
    final payload = _payload;
    if (payload == null) return const [];

    final selectedIds = _selectedRouteIds;
    final onlyEndpoints = _prefs.hideIntermediateStations;

    if (_prefs.isGrouped) {
      final candidates = payload.groups.where((group) {
        if (selectedIds == null) return true;
        return group.stationIndices.any((i) =>
            payload.stations[i].routeIds.any(selectedIds.contains));
      }).toList();

      return thinByViewport(
        markers: candidates,
        zoom: _zoom,
        north: _bounds?.north,
        south: _bounds?.south,
        east: _bounds?.east,
        west: _bounds?.west,
        selected: _selectedGroup,
      )
          .map((group) => _marker(
                position: group.position,
                label: group.name,
                isMain: true,
                isSelected: identical(group, _selectedGroup),
                palette: palette,
                onTap: () => _selectGroup(group),
              ))
          .toList();
    }

    final candidates = payload.stations.where((station) {
      if (onlyEndpoints && !station.isMain) return false;
      if (selectedIds == null) return true;
      return station.routeIds.any(selectedIds.contains);
    }).toList();

    return thinByViewport(
      markers: candidates,
      zoom: _zoom,
      north: _bounds?.north,
      south: _bounds?.south,
      east: _bounds?.east,
      west: _bounds?.west,
      selected: _selectedStation,
    )
        .map((station) => _marker(
              position: station.position,
              label: station.name,
              isMain: station.isMain,
              isSelected: identical(station, _selectedStation),
              palette: palette,
              onTap: () => _selectStation(station),
            ))
        .toList();
  }

  /// A small dot inside a 44 px tap target — the same touch size the web's
  /// `mapIcons.js` uses, which is the minimum that reliably hits with a thumb.
  Marker _marker({
    required LatLng position,
    required String label,
    required bool isMain,
    required bool isSelected,
    required MapPalette palette,
    required VoidCallback onTap,
  }) {
    final scheme = Theme.of(context).colorScheme;
    final size = isSelected ? 16.0 : (isMain ? 11.0 : 8.0);
    return Marker(
      point: position,
      width: 44,
      height: 44,
      alignment: Alignment.center,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Tooltip(
          message: label,
          waitDuration: const Duration(milliseconds: 400),
          child: Center(
            child: Container(
              width: size,
              height: size,
              decoration: BoxDecoration(
                color: isSelected ? scheme.primary : scheme.surface,
                shape: BoxShape.circle,
                border: Border.all(
                  color: isSelected ? scheme.onPrimary : scheme.primary,
                  width: isMain ? 2.2 : 1.6,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<Marker> _placeLabels(Basemap basemap, MapPalette palette) =>
      basemap.placesForZoom(_zoom).map((place) {
        return Marker(
          point: place.position,
          width: 140,
          height: 18,
          alignment: Alignment.center,
          child: IgnorePointer(
            child: Text(
              place.name,
              textAlign: TextAlign.center,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: place.rank == 0 ? 11 : 10,
                color: palette.label,
                fontWeight:
                    place.rank == 0 ? FontWeight.w600 : FontWeight.w400,
                shadows: [
                  Shadow(color: palette.labelHalo, blurRadius: 3),
                  Shadow(color: palette.labelHalo, blurRadius: 3),
                ],
              ),
            ),
          ),
        );
      }).toList();

  // --- build --------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final palette = MapPalette.of(context);
    final payload = _payload;
    final basemap = _basemap;

    if (_loadError != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Night Trains')),
        body: _ErrorView(error: _loadError!, onRetry: () {
          setState(() => _loadError = null);
          _bootstrap();
        }),
      );
    }

    if (payload == null || basemap == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final strip = _stripRoutes;

    return Scaffold(
      body: Stack(
        children: [
          FlutterMap(
            mapController: _map,
            options: MapOptions(
              initialCenter: _defaultCenter,
              initialZoom: _defaultZoom,
              minZoom: 2,
              maxZoom: 12,
              backgroundColor: palette.sea,
              onTap: (_, __) => _clearSelection(),
              onPositionChanged: (camera, _) {
                // Rebuild only when thinning could actually change.
                final zoomChanged = (camera.zoom - _zoom).abs() > 0.01;
                if (zoomChanged || _bounds != camera.visibleBounds) {
                  setState(() {
                    _zoom = camera.zoom;
                    _bounds = camera.visibleBounds;
                  });
                }
              },
            ),
            children: [
              PolygonLayer(
                polygons: _basemapPolygons(basemap, palette),
                // Earcut triangulation via drawVertices: the fine level is
                // 1,504 polygons and this is what keeps panning smooth.
                useAltRendering: true,
                polygonCulling: true,
              ),
              PolylineLayer(polylines: _routePolylines()),
              MarkerLayer(markers: _placeLabels(basemap, palette)),
              MarkerLayer(markers: _stationMarkers(palette)),
            ],
          ),
          SafeArea(
            child: Align(
              alignment: Alignment.topCenter,
              child: _TopBar(
                title: _selectionTitle(),
                onSearch: () => _openSearch(payload),
                onNearby: () => _openNearby(payload),
                onToggles: _openToggles,
              ),
            ),
          ),
          if (strip.isNotEmpty)
            Align(
              alignment: Alignment.bottomCenter,
              child: RouteStrip(
                routes: strip,
                onSelect: _openRoute,
                onClose: _clearSelection,
              ),
            ),
        ],
      ),
    );
  }

  String _selectionTitle() {
    if (_selectedGroup != null) return _selectedGroup!.name;
    if (_selectedStation != null) return _selectedStation!.name;
    return 'Night Trains';
  }

  void _openSearch(MapPayload payload) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => SearchSheet(
        payload: payload,
        onSelect: (station) {
          Navigator.of(context).pop();
          _selectStation(station);
          _goTo(station.position);
        },
      ),
    );
  }

  void _openNearby(MapPayload payload) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => NearbySheet(
        stations: payload.stations,
        onSelect: (station) {
          Navigator.of(context).pop();
          _selectStation(station);
          _goTo(station.position);
        },
      ),
    );
  }

  void _openToggles() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => StatefulBuilder(
        builder: (context, setSheetState) {
          void update(MapPreferences next) {
            setSheetState(() {});
            setState(() => _prefs = next);
            next.save();
          }

          return SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                SwitchListTile(
                  title: const Text('Group stations by city'),
                  subtitle: const Text('One marker per city instead of per station'),
                  value: _prefs.isGrouped,
                  onChanged: (v) => update(_prefs.copyWith(isGrouped: v)),
                ),
                SwitchListTile(
                  title: const Text('Show all routes'),
                  subtitle: const Text('Draw the whole network, not just the selection'),
                  value: _prefs.showRoutes,
                  onChanged: (v) => update(_prefs.copyWith(showRoutes: v)),
                ),
                SwitchListTile(
                  title: const Text('Endpoints only'),
                  subtitle: const Text('Hide stations trains merely pass through'),
                  value: _prefs.hideIntermediateStations,
                  onChanged: (v) =>
                      update(_prefs.copyWith(hideIntermediateStations: v)),
                ),
                const Divider(height: 1),
                ListTile(
                  dense: true,
                  title: Text(
                    _basemap?.attribution ?? '',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({
    required this.title,
    required this.onSearch,
    required this.onNearby,
    required this.onToggles,
  });

  final String title;
  final VoidCallback onSearch;
  final VoidCallback onNearby;
  final VoidCallback onToggles;

  @override
  Widget build(BuildContext context) => Card(
        margin: const EdgeInsets.all(12),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Row(
            children: [
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  title,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              const Spacer(),
              IconButton(
                onPressed: onSearch,
                icon: const Icon(Icons.search),
                tooltip: 'Search stations',
              ),
              IconButton(
                onPressed: onNearby,
                icon: const Icon(Icons.my_location),
                tooltip: 'Stations near me',
              ),
              IconButton(
                onPressed: onToggles,
                icon: const Icon(Icons.layers_outlined),
                tooltip: 'Map options',
              ),
            ],
          ),
        ),
      );
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.error, required this.onRetry});

  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.cloud_off, size: 40),
              const SizedBox(height: 12),
              const Text(
                'The map data could not be loaded.',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 6),
              Text(
                '$error',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 16),
              FilledButton(onPressed: onRetry, child: const Text('Try again')),
            ],
          ),
        ),
      );
}
