import { useEffect } from 'react';
import { ZoomControl as ReactLeafletZoomControl, useMap } from 'react-leaflet';

/**
 * Enhanced ZoomControl component that wraps react-leaflet's ZoomControl
 * with blue highlight styling on click
 */
const ZoomControl = (props) => {
  const map = useMap();

  useEffect(() => {
    // Setup click handlers after the map and controls are initialized
    const setupZoomControlEnhancements = () => {
      // Wait for the DOM to be fully rendered with the ZoomControl
      setTimeout(() => {
        const zoomInButton = document.querySelector('.leaflet-control-zoom-in');
        const zoomOutButton = document.querySelector('.leaflet-control-zoom-out');

        if (!zoomInButton || !zoomOutButton) return;

        // Helper function to add active state temporarily
        const handleButtonClick = (button) => {
          button.classList.add('zoom-control-active');
          setTimeout(() => {
            button.classList.remove('zoom-control-active');
          }, 300);
        };

        // Store reference to original handlers to properly clean up
        const handleZoomInClick = () => handleButtonClick(zoomInButton);
        const handleZoomOutClick = () => handleButtonClick(zoomOutButton);

        // Add click event listeners
        zoomInButton.addEventListener('click', handleZoomInClick);
        zoomOutButton.addEventListener('click', handleZoomOutClick);

        // Store handlers for cleanup
        zoomInButton._enhancedHandler = handleZoomInClick;
        zoomOutButton._enhancedHandler = handleZoomOutClick;
      }, 100);
    };

    if (map._loaded) {
      setupZoomControlEnhancements();
    } else {
      map.once('load', setupZoomControlEnhancements);
    }

    // Cleanup function
    return () => {
      const zoomInButton = document.querySelector('.leaflet-control-zoom-in');
      const zoomOutButton = document.querySelector('.leaflet-control-zoom-out');

      if (zoomInButton && zoomInButton._enhancedHandler) {
        zoomInButton.removeEventListener('click', zoomInButton._enhancedHandler);
      }

      if (zoomOutButton && zoomOutButton._enhancedHandler) {
        zoomOutButton.removeEventListener('click', zoomOutButton._enhancedHandler);
      }
    };
  }, [map]);

  // Render the standard react-leaflet ZoomControl
  return <ReactLeafletZoomControl {...props} />;
};

export default ZoomControl;