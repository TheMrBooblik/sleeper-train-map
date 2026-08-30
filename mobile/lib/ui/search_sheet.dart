import 'package:flutter/material.dart';

import '../data/models.dart';

/// Station search.
///
/// The whole station list is 1,880 entries — small enough that a linear scan per
/// keystroke is imperceptible, and far simpler than an index that would have to
/// be kept in step with the payload.
class SearchSheet extends StatefulWidget {
  const SearchSheet({super.key, required this.payload, required this.onSelect});

  final MapPayload payload;
  final ValueChanged<Station> onSelect;

  @override
  State<SearchSheet> createState() => _SearchSheetState();
}

class _SearchSheetState extends State<SearchSheet> {
  final TextEditingController _controller = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  List<Station> get _results {
    final query = _query.trim().toLowerCase();
    if (query.isEmpty) {
      // With no query, the endpoints with the most trains are the most useful
      // thing to offer.
      final stations = widget.payload.stations.where((s) => s.isMain).toList()
        ..sort((a, b) => b.routeIds.length.compareTo(a.routeIds.length));
      return stations.take(25).toList();
    }

    final matches = widget.payload.stations
        .where((s) => s.name.toLowerCase().contains(query))
        .toList()
      // A prefix match is what the user meant; then endpoints over via-stops,
      // then busier stations first.
      ..sort((a, b) {
        final aPrefix = a.name.toLowerCase().startsWith(query) ? 0 : 1;
        final bPrefix = b.name.toLowerCase().startsWith(query) ? 0 : 1;
        if (aPrefix != bPrefix) return aPrefix - bPrefix;
        if (a.isMain != b.isMain) return a.isMain ? -1 : 1;
        return b.routeIds.length.compareTo(a.routeIds.length);
      });
    return matches.take(50).toList();
  }

  @override
  Widget build(BuildContext context) {
    final results = _results;
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.7,
      maxChildSize: 0.94,
      builder: (context, controller) => Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: TextField(
              controller: _controller,
              autofocus: true,
              textInputAction: TextInputAction.search,
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Search stations',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              onChanged: (value) => setState(() => _query = value),
            ),
          ),
          Expanded(
            child: results.isEmpty
                ? const Center(child: Text('No stations match that.'))
                : ListView.builder(
                    controller: controller,
                    itemCount: results.length,
                    itemBuilder: (context, index) {
                      final station = results[index];
                      final count = station.routeIds.length;
                      return ListTile(
                        dense: true,
                        leading: Icon(
                          station.isMain ? Icons.train : Icons.circle_outlined,
                          size: 18,
                        ),
                        title: Text(station.name),
                        subtitle:
                            Text(count == 1 ? '1 train' : '$count trains'),
                        onTap: () => widget.onSelect(station),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
