import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

import 'basemap.dart';
import 'models.dart';

/// Where the map data comes from, in order of increasing freshness and
/// decreasing certainty:
///
///   1. the asset bundled in the build — always present, so a first launch in a
///      tunnel still draws the whole network;
///   2. the last good download on disk — survives reinstall-free upgrades and
///      offline launches;
///   3. the network — one conditional GET per launch.
///
/// The file is a plain CDN object (`public/` on Vercel, and the middleware only
/// guards `/data` exactly), so there is no API, no lambda and no key. With an
/// ETag the usual answer is 304 and nothing is transferred.
///
/// The schema is frozen per version: a breaking change goes to `mobile-v2.json`
/// so a published app keeps reading the file it understands.
class DataRepository {
  DataRepository({http.Client? client}) : _client = client ?? http.Client();

  static const String payloadUrl =
      'https://pingwi.com/data/published/mobile-v1.json';
  static const String _seedAsset = 'assets/seed-v1.json.gz';
  static const String _basemapAsset = 'assets/basemap.json.gz';
  static const String _cacheFile = 'mobile-v1.json';
  static const String _etagFile = 'mobile-v1.etag';

  final http.Client _client;

  /// Load the payload from the best source already on the device.
  ///
  /// Never throws and never returns null: a corrupt cache falls back to the
  /// bundled seed, because a map that draws slightly stale routes is strictly
  /// better than one that draws nothing.
  Future<MapPayload> loadLocal() async {
    final cached = await _readCache();
    if (cached != null) return cached;
    return _decodePayload(await _readGzipAsset(_seedAsset));
  }

  /// Fetch a newer payload, or null when there is nothing new or no network.
  ///
  /// Deliberately quiet: a refresh failure is not worth interrupting someone
  /// looking at a map that is already on screen.
  Future<MapPayload?> refresh() async {
    try {
      final etag = await _readEtag();
      final response = await _client.get(
        Uri.parse(payloadUrl),
        headers: {
          if (etag != null) 'If-None-Match': etag,
          'Accept-Encoding': 'gzip',
        },
      ).timeout(const Duration(seconds: 20));

      if (response.statusCode == 304) return null;
      if (response.statusCode != 200) return null;

      final text = utf8.decode(response.bodyBytes);
      final payload = _decodePayload(text);

      // Only persist once it has parsed: a truncated body must not evict a
      // cache that still works.
      await _writeCache(text, response.headers['etag']);
      return payload;
    } on TimeoutException {
      return null;
    } on SocketException {
      return null;
    } catch (error) {
      debugPrint('[repository] refresh failed: $error');
      return null;
    }
  }

  Future<Basemap> loadBasemap() async {
    final text = await _readGzipAsset(_basemapAsset);
    return Basemap.fromJson(jsonDecode(text) as Map<String, dynamic>);
  }

  // --- storage ------------------------------------------------------------

  Future<String> _readGzipAsset(String key) async {
    final bytes = await rootBundle.load(key);
    return utf8.decode(gzip.decode(bytes.buffer.asUint8List()));
  }

  MapPayload _decodePayload(String text) =>
      MapPayload.fromJson(jsonDecode(text) as Map<String, dynamic>);

  Future<File> _file(String name) async {
    final dir = await getApplicationSupportDirectory();
    return File('${dir.path}/$name');
  }

  Future<MapPayload?> _readCache() async {
    try {
      final file = await _file(_cacheFile);
      if (!await file.exists()) return null;
      return _decodePayload(await file.readAsString());
    } catch (error) {
      debugPrint('[repository] cache unreadable, falling back to seed: $error');
      return null;
    }
  }

  Future<void> _writeCache(String text, String? etag) async {
    try {
      await (await _file(_cacheFile)).writeAsString(text, flush: true);
      final etagFile = await _file(_etagFile);
      if (etag == null) {
        if (await etagFile.exists()) await etagFile.delete();
      } else {
        await etagFile.writeAsString(etag, flush: true);
      }
    } catch (error) {
      // A full disk costs the next launch a download, nothing more.
      debugPrint('[repository] could not persist payload: $error');
    }
  }

  Future<String?> _readEtag() async {
    try {
      final file = await _file(_etagFile);
      if (!await file.exists()) return null;
      final cache = await _file(_cacheFile);
      // An ETag without its payload would suppress the download that would
      // create it — a 304 with nothing to show.
      if (!await cache.exists()) return null;
      return (await file.readAsString()).trim();
    } catch (_) {
      return null;
    }
  }
}
