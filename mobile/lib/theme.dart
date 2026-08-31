import 'package:flutter/material.dart';

/// A deliberately quiet basemap palette.
///
/// The web draws over OpenStreetMap raster tiles, which carry roads, labels and
/// landuse the routes then have to compete with. Drawing our own basemap is a
/// chance to fix that: land and sea are near-neutral, borders are a hairline,
/// and the only saturated colour on screen is a train route. On a thematic map
/// that is the whole point — the reader is looking for corridors, not streets.
class MapPalette {
  const MapPalette({
    required this.sea,
    required this.land,
    required this.border,
    required this.lake,
    required this.label,
    required this.labelHalo,
  });

  final Color sea;
  final Color land;
  final Color border;
  final Color lake;
  final Color label;
  final Color labelHalo;

  static const light = MapPalette(
    sea: Color(0xFFDCE6EC),
    land: Color(0xFFF6F4EF),
    border: Color(0xFFCFC9BF),
    lake: Color(0xFFD2DFE8),
    label: Color(0xFF5A5A5A),
    labelHalo: Color(0xFFF6F4EF),
  );

  static const dark = MapPalette(
    sea: Color(0xFF10161C),
    land: Color(0xFF1E262E),
    border: Color(0xFF39434D),
    lake: Color(0xFF16202A),
    label: Color(0xFF9AA5AE),
    labelHalo: Color(0xFF10161C),
  );

  static MapPalette of(BuildContext context) =>
      Theme.of(context).brightness == Brightness.dark ? dark : light;
}

const Color _seed = Color(0xFF1F6FEB);

ThemeData buildTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(seedColor: _seed, brightness: brightness);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: scheme.surface,
    visualDensity: VisualDensity.adaptivePlatformDensity,
  );
}
