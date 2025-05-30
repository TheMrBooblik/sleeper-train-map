import { useEffect, useState } from 'react';
import { useMap, Circle, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';

const LocationControl = () => {
  const map = useMap();
  const [position, setPosition] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [isLocating, setIsLocating] = useState(false);

  const locationIcon = L.divIcon({
    html: `
      <div style="position: relative; width: 20px; height: 20px;">
        <div style="
          position: absolute;
          width: 20px;
          height: 20px;
          background-color: #007aff;
          border: 3px solid white;
          border-radius: 50%;
          box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        "></div>
        <div style="
          position: absolute;
          width: 40px;
          height: 40px;
          top: -10px;
          left: -10px;
          background-color: rgba(0, 122, 255, 0.15);
          border-radius: 50%;
          animation: pulse 2s ease-out infinite;
        "></div>
      </div>
    `,
    className: 'location-marker',
    iconSize: [20, 20],
    iconAnchor: [10, 10]
  });

      // Store current zoom level to avoid aggressive zooming
      const [previousZoom, setPreviousZoom] = useState(null);

      // Add debounce to prevent rapid-firing of location requests
      const [lastLocationTime, setLastLocationTime] = useState(0);
    // Add loading state to show user something is happening
    const [loadingMessage, setLoadingMessage] = useState('');

    const handleLocationFind = () => {
      // Debounce to avoid twitchy behavior - only allow location every 3 seconds
      const now = Date.now();
      if (now - lastLocationTime < 3000) {
        // Give user feedback that we're ignoring rapid clicks
        setLoadingMessage('Please wait a moment before trying again');
        setTimeout(() => setLoadingMessage(''), 1500);
        return;
      }
      setLastLocationTime(now);

      if (isLocating) return;

      // Show loading message
      setLoadingMessage('Finding your location...');

    // Store current zoom level before locating
    setPreviousZoom(map.getZoom());
    setIsLocating(true);

    if (!navigator.geolocation) {
      alert('Geolocation is not supported by your browser');
      setIsLocating(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;

        setPosition([latitude, longitude]);
        setAccuracy(accuracy);

        // Calculate appropriate zoom level based on current state
        // Prioritize stability and wider view
        const currentZoom = map.getZoom();

        // If we're already at a reasonable zoom level, keep it exactly the same
        let targetZoom;
        if (currentZoom > 5 && currentZoom < 9) {
          // Keep exactly the same zoom level if we're in a reasonable range
          targetZoom = currentZoom;
        } else {
          // Otherwise use a conservative default that shows plenty of context
          targetZoom = 6;
        }

        // No animation - just set the view instantly
        map.setView([latitude, longitude], targetZoom, {
          animate: false
        });

        // Clear loading message and locating state
        setLoadingMessage('');
        setIsLocating(false);
      },
      (error) => {
        let errorMessage = 'Unable to retrieve your location';

        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMessage = 'Location permission denied. Please enable location access in your browser settings.';
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage = 'Location information is unavailable.';
            break;
          case error.TIMEOUT:
            errorMessage = 'The request to get your location timed out.';
            break;
        }

        // Display error in UI instead of showing an alert
        setLoadingMessage(errorMessage);
        setTimeout(() => setLoadingMessage(''), 3000);
        setIsLocating(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 5000,
        maximumAge: 0
      }
    );
  };

  useEffect(() => {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    const link = L.DomUtil.create('a', '', container);

    link.href = '#';
    link.title = 'My location';
    link.setAttribute('role', 'button');
    link.setAttribute('aria-label', 'My location');

    link.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: block; margin: 6px;">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M12 2v3m0 14v3m10-10h-3M5 12H2"></path>
      </svg>
    `;

    link.style.width = '30px';
    link.style.height = '30px';
    link.style.lineHeight = '30px';
    link.style.textAlign = 'center';
    link.style.textDecoration = 'none';
    // Dynamic coloring based on state
    if (isLocating) {
      link.style.color = '#007aff';
      link.style.backgroundColor = '#f0f8ff';
    } else if (loadingMessage) {
      link.style.color = '#f39c12';  // Orange for warnings/messages
      link.style.backgroundColor = '#fff9e6';
    } else {
      link.style.color = '#333';
      link.style.backgroundColor = 'white';
    }

    link.style.fontSize = '18px';
    link.style.fontWeight = 'bold';
    link.style.display = 'flex';
    link.style.alignItems = 'center';
    link.style.justifyContent = 'center';
    link.style.transition = 'color 0.3s, background-color 0.3s';

    // Add tooltip based on current state
    link.title = isLocating ? 'Finding your location...' : 'Find my location';

    L.DomEvent.on(link, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      L.DomEvent.stopPropagation(e);
      handleLocationFind();
    });

    const LocationButton = L.Control.extend({
      options: {
        position: 'topleft'
      },
      onAdd: () => container
    });

    const control = new LocationButton();
    map.addControl(control);

    const style = document.createElement('style');
    style.textContent = `
      @keyframes pulse {
        0% {
          transform: scale(1);
          opacity: 1;
        }
        100% {
          transform: scale(2);
          opacity: 0;
        }
      }
      .location-marker {
        background: none !important;
        border: none !important;
      }
    `;
    document.head.appendChild(style);

    return () => {
      map.removeControl(control);
      style.remove();
    };
  }, [map, isLocating]);

      // Add throttling for position updates to prevent rapid UI changes
      const [stablePosition, setStablePosition] = useState(null);
      const [stableAccuracy, setStableAccuracy] = useState(null);

      // Only update the UI position when we have significant changes
      useEffect(() => {
    if (!position) return;

    // Update position with a delay to prevent jerky UI changes
    const updateTimer = setTimeout(() => {
      setStablePosition(position);
      setStableAccuracy(accuracy);
    }, 300); // Short delay for smoother transitions

    return () => clearTimeout(updateTimer);
      }, [position, accuracy]);

      return (
    <>
      {/* Add loading message to UI */}
      {loadingMessage && (
        <div 
          style={{
            position: 'absolute',
            bottom: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: 'rgba(0,0,0,0.7)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '4px',
            fontSize: '14px',
            zIndex: 1000,
            pointerEvents: 'none'
          }}
        >
          {loadingMessage}
        </div>
      )}

      {stablePosition && (
        <>
          <Circle
            center={stablePosition}
            radius={stableAccuracy}
            pathOptions={{
              color: '#007aff',
              fillColor: '#007aff',
              fillOpacity: 0.15,
              weight: 1
            }}
          />
          <Marker position={stablePosition} icon={locationIcon}>
            <Popup>You are here</Popup>
          </Marker>
        </>
      )}
    </>
  );
};

export default LocationControl;