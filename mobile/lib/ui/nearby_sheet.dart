import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../data/models.dart';
import '../logic/geo.dart';

/// "Stations near me" — the one feature that asks for a permission, and it asks
/// only when opened rather than at launch.
///
/// Everything after the fix is arithmetic on data already in memory: the app
/// never sends a position anywhere.
class NearbySheet extends StatefulWidget {
  const NearbySheet({super.key, required this.stations, required this.onSelect});

  final List<Station> stations;
  final ValueChanged<Station> onSelect;

  @override
  State<NearbySheet> createState() => _NearbySheetState();
}

class _NearbySheetState extends State<NearbySheet> {
  List<NearbyStation>? _results;
  String? _error;

  @override
  void initState() {
    super.initState();
    _locate();
  }

  Future<void> _locate() async {
    setState(() {
      _error = null;
      _results = null;
    });
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        throw 'Location services are turned off.';
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        throw 'Location permission was declined.';
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.low,
          timeLimit: Duration(seconds: 15),
        ),
      );
      if (!mounted) return;
      setState(() {
        _results = nearestStations(
          widget.stations,
          position.latitude,
          position.longitude,
          limit: 12,
        );
      });
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    }
  }

  @override
  Widget build(BuildContext context) {
    final results = _results;
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      maxChildSize: 0.9,
      builder: (context, controller) {
        if (_error != null) {
          return Center(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.location_disabled, size: 36),
                  const SizedBox(height: 12),
                  Text(_error!, textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  FilledButton(
                    onPressed: _locate,
                    child: const Text('Try again'),
                  ),
                ],
              ),
            ),
          );
        }
        if (results == null) {
          return const Center(child: CircularProgressIndicator());
        }
        if (results.isEmpty) {
          return const Center(child: Text('No sleeper stations nearby.'));
        }
        return ListView.builder(
          controller: controller,
          itemCount: results.length,
          itemBuilder: (context, index) {
            final entry = results[index];
            return ListTile(
              dense: true,
              leading: const Icon(Icons.train, size: 18),
              title: Text(entry.station.name),
              subtitle: Text(
                '${formatDistanceKm(entry.distanceKm)} · '
                '${entry.station.routeIds.length} trains',
              ),
              onTap: () => widget.onSelect(entry.station),
            );
          },
        );
      },
    );
  }
}
