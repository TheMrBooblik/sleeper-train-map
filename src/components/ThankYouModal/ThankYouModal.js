import { useCallback, useEffect } from "react";
import { FaGithub, FaExternalLinkAlt } from "react-icons/fa";

export default function ThankYouModal({ isModalOpen, setModalIsOpen }) {
  const escFunction = useCallback(
    (event) => {
      if (event.key === "Escape") {
        setModalIsOpen(false);
      }
    },
    [setModalIsOpen],
  );

  useEffect(() => {
    if (!isModalOpen) return undefined;

    document.addEventListener("keydown", escFunction, false);

    return () => {
      document.removeEventListener("keydown", escFunction, false);
    };
  }, [isModalOpen, escFunction]);

  // Handle click outside modal to close it
  const handleBackdropClick = useCallback(
    (event) => {
      // Only close if clicking directly on the backdrop, not on modal content
      if (event.target === event.currentTarget) {
        setModalIsOpen(false);
      }
    },
    [setModalIsOpen],
  );

  if (!isModalOpen) return null;

  return (
    <div
      className="fixed inset-0 z-999 flex items-center justify-center backdrop-blur-sm cursor-pointer"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-white max-w-lg w-full p-8 rounded-2xl shadow-xl relative cursor-default"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-2xl font-bold text-center text-gray-700 mt-4 mb-6">
          🚂 European Sleeper Train Map
        </h2>

        <div className="text-gray-700 space-y-4 leading-relaxed">
          <p className="text-center text-md font-medium mb-4">
            Explore the extensive network of night trains across Europe.
          </p>

          <div className="bg-blue-50 p-4 rounded-lg border-l-4 border-blue-600">
            <p className="mb-2">
              This interactive map visualizes the{" "}
              <strong>night train routes</strong> connecting major European
              cities, helping travelers plan sustainable long-distance journeys
              without flying. Click on any station to see its connections!
            </p>
          </div>

          <div className="flex justify-between items-center gap-4 mt-6">
            <a
              href="https://back-on-track.eu/night-train-map"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition"
            >
              <FaExternalLinkAlt className="text-gray-800" />
              <span>Back-on-Track Map</span>
            </a>
          </div>

          <p className="text-center text-sm mt-4">
            Huge thanks to
            <a
              href="https://back-on-track.eu"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 transition font-medium mx-1"
            >
              Back-on-Track.eu
            </a>
            for providing the data for this visualization!
          </p>
        </div>

        <div className="mt-8 text-center">
          <button
            onClick={() => setModalIsOpen(false)}
            className="w-full px-6 py-2.5 bg-black text-white rounded-lg hover:bg-grey-700 transition shadow-md font-medium cursor-pointer"
          >
            LET'S GO TO THE MAP!
          </button>
        </div>
      </div>
    </div>
  );
}
