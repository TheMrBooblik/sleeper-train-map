"use client"

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import Leaflet from 'leaflet';
import * as ReactLeaflet from 'react-leaflet';

const {MapContainer, Marker, TileLayer} = ReactLeaflet;
import 'leaflet/dist/leaflet.css';

import styles from './Map.module.scss';
import Filter from "src/components/Filter";
import { useStops } from "../../hooks/requests/useStops";
import { useCities } from "../../hooks/requests/useCities";
import TrainSidebar from "@components/TrainSidebar";

const Map = ({children, className, ...rest}) => {
  const [sidebarDisabled, setSidebarDisabled] = useState(false);
  const {stops, filteredStops, setFilteredStops} = useStops();
  const {cities} = useCities();
  const [selected, setSelected] = useState(false);
  const [stopId, setStopId] = useState();
  const [stopRouteIds, setStopRouteIds] = useState();
  const mapRef = useRef();
  const sidebarRef = useRef(null);

  const mapClassName = className ? `${styles.map} ${className}` : styles.map;

  const removeFilter = () => {
    setStopId(null);
    setSelected(false);
    setFilteredStops(stops);
  }

  const escFunction = useCallback((event) => {
    if (event.key === "Escape") {
      removeFilter()
    }
  }, [setFilteredStops, stops]);

  useEffect(() => {
    document.addEventListener("keydown", escFunction, false);

    return () => {
      document.removeEventListener("keydown", escFunction, false);
    };
  }, [escFunction]);

  const defaultIcon = useMemo(() => new Leaflet.Icon({
    iconUrl: 'leaflet/images/marker-icon.png',
    iconRetinaUrl: 'leaflet/images/marker-icon-2x.png',
    shadowUrl: 'leaflet/images/marker-shadow.png',
    iconSize: [25, 41],
    iconAnchor: [12, 41],
    popupAnchor: [1, -34],
    shadowSize: [41, 41]
  }), []);

  const selectedIcon = useMemo(() => new Leaflet.Icon({
    iconUrl: 'leaflet/images/marker-icon.png',
    iconRetinaUrl: 'leaflet/images/marker-icon-2x.png',
    shadowUrl: 'leaflet/images/marker-shadow.png',
    iconSize: [35, 57], // larger size
    iconAnchor: [17, 57],
    popupAnchor: [1, -34],
    shadowSize: [41, 41],
    className: 'selected-marker' // We can add CSS for this class in your styles
  }), []);

  const handleMarkerClick = useCallback((filteredStop) => {
    const {stop_id} = filteredStop;
    setStopId(stop_id);
    const cityInfo = cities[stop_id];

    if (!cityInfo) return;

    const {stop_route_ids} = cityInfo;

    const routeIdsArray = stop_route_ids.split(",").filter(el => el);
    setStopRouteIds(routeIdsArray);

    const routeCities = Object.values(cities).filter(
      (viewCity) => {
        const arr = viewCity.stop_route_ids.split(",");
        return arr.some(item => routeIdsArray.includes(item));
      }
    );

    const routeStops = routeCities.map(el =>
      stops.find(stop => stop.stop_id === el.stop_id)
    ).filter(Boolean);

    setFilteredStops(routeStops);
    setSelected(true);
  }, [cities, stops, setFilteredStops]);

  const markers = useMemo(() => {
    return filteredStops?.map((filteredStop, index) => {
      const isSelected = stopId === filteredStop?.stop_id;
      const stopLat = filteredStop?.stop_lat;
      const stopLon = filteredStop?.stop_lon;

      const {stop_id} = filteredStop;
      const cityInfo = cities[stop_id];
      const {stop_route_ids} = cityInfo || {};

      if (!stopLat || !stopLon || !stop_route_ids) return null;

      return (
        <Marker
          key={`${filteredStop?.stop_id || index}`}
          position={[stopLat, stopLon]}
          icon={isSelected ? selectedIcon : defaultIcon}
          eventHandlers={{
            click: (e) => {
              handleMarkerClick(filteredStop)
            },
          }}
        />
      )
    }).filter(Boolean); // Filter out null markers
  }, [filteredStops, handleMarkerClick]);

  return (
    <>
      <MapContainer className={mapClassName} ref={mapRef} {...rest}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
        <Filter selected={selected} filterName={stopId} onClose={removeFilter}/>
        {markers}
        {children && children({MapContainer, Marker, TileLayer}, Leaflet)}
      </MapContainer>

      <div ref={sidebarRef}>
        <TrainSidebar
          isOpen={selected}
          sidebarDisabled={sidebarDisabled}
          setSidebarDisabled={setSidebarDisabled}
          stopId={stopId}
          stopRouteIds={stopRouteIds}
        />
      </div>
    </>
  );
};

export default Map;