import 'package:shared_preferences/shared_preferences.dart';

/// The map's three toggles, stored under the keys the web already uses in
/// localStorage. Same names and same defaults, so the two surfaces describe the
/// same preference rather than two unrelated ones — and so a future sync has
/// nothing to reconcile.
///
/// The fourth web toggle, the OpenRailwayMap overlay, has no counterpart: it is
/// a tile layer, and the app has no tile server by design.
class MapPreferences {
  const MapPreferences({
    this.isGrouped = true,
    this.showRoutes = false,
    this.hideIntermediateStations = false,
  });

  /// Collapse a city's stations into one marker. On by default, as on the web.
  final bool isGrouped;

  /// Draw every route, not just the selected station's. Off by default — the
  /// full network is 281 lines and reads as noise until you have picked a city.
  final bool showRoutes;

  /// Show only endpoints, hiding the stations a train merely passes through.
  final bool hideIntermediateStations;

  static const _groupedKey = 'train-map:isGrouped';
  static const _routesKey = 'train-map:showRoutes';
  static const _intermediateKey = 'train-map:hideIntermediateStations';

  MapPreferences copyWith({
    bool? isGrouped,
    bool? showRoutes,
    bool? hideIntermediateStations,
  }) =>
      MapPreferences(
        isGrouped: isGrouped ?? this.isGrouped,
        showRoutes: showRoutes ?? this.showRoutes,
        hideIntermediateStations:
            hideIntermediateStations ?? this.hideIntermediateStations,
      );

  static Future<MapPreferences> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return MapPreferences(
        isGrouped: prefs.getBool(_groupedKey) ?? true,
        showRoutes: prefs.getBool(_routesKey) ?? false,
        hideIntermediateStations: prefs.getBool(_intermediateKey) ?? false,
      );
    } catch (_) {
      // Preferences are a convenience; a failure to read them is not worth a
      // blank map.
      return const MapPreferences();
    }
  }

  Future<void> save() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_groupedKey, isGrouped);
      await prefs.setBool(_routesKey, showRoutes);
      await prefs.setBool(_intermediateKey, hideIntermediateStations);
    } catch (_) {
      // Ignored for the same reason.
    }
  }
}
