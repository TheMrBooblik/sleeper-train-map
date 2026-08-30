import 'package:flutter/material.dart';

import 'theme.dart';
import 'ui/map_screen.dart';

void main() => runApp(const NightTrainsApp());

class NightTrainsApp extends StatelessWidget {
  const NightTrainsApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Night Trains',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(Brightness.light),
        darkTheme: buildTheme(Brightness.dark),
        home: const MapScreen(),
      );
}
