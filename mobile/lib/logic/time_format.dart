import '../data/models.dart';

/// Turning a schedule's stored time into something to show.
///
/// The nine operator feeds do not agree on what their time strings mean, and the
/// web papers over it by running every value through `new Date(…)` and
/// formatting in the browser's zone. That works in a browser and would be wrong
/// in a build: pre-formatting a Nightjet departure in a UTC CI runner prints
/// Bruxelles Midi at 17:06 instead of 19:06.
///
/// So the payload keeps instants as instants and tags the schedule `utc`, keeps
/// everything else as a wall clock and tags it `wall`. This is the only place
/// that distinction is spent — which is why [Stop.arrival] says not to format
/// the raw strings anywhere else.
String? formatStopTime(String? value, TimeZoneKind tz) {
  if (value == null || value.isEmpty) return null;

  if (tz == TimeZoneKind.wall) return value;

  final parsed = DateTime.tryParse(value);
  if (parsed == null) return value;
  final local = parsed.toLocal();
  return '${_two(local.hour)}:${_two(local.minute)}';
}

String _two(int value) => value.toString().padLeft(2, '0');

/// "18:00 → 13:25" for a direction's endpoints, skipping either half when the
/// feed does not publish it.
String formatEndpointTimes(String? departure, String? arrival) {
  if (departure == null && arrival == null) return '';
  if (departure == null) return '→ $arrival';
  if (arrival == null) return '$departure →';
  return '$departure → $arrival';
}
