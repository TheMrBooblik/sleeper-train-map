import { useCallback, useEffect } from "react";

export default function ThankYouModal({ isModalOpen, setModalIsOpen }) {
  if (!isModalOpen) return null;

  const escFunction = useCallback((event) => {
    if (event.key === "Escape") {
      setModalIsOpen(false)
    }
  }, [setModalIsOpen]);

  useEffect(() => {
    document.addEventListener("keydown", escFunction, false);

    return () => {
      document.removeEventListener("keydown", escFunction, false);
    };
  }, [escFunction]);

  return (
    <div className="fixed inset-0 z-999 flex items-center justify-center backdrop-blur-xs bg-opacity-40">
      <div className="bg-white max-w-md w-full p-6 rounded-2xl shadow-lg relative">
        <button
          onClick={() => setModalIsOpen(false)}
          className="absolute top-3 right-3 text-gray-500 hover:text-gray-700 text-xl font-bold cursor-pointer"
          aria-label="Close modal"
        >
          ×
        </button>

        <br/><br/>
        <div className="text-gray-700 space-y-3">
          <p>
            This website uses data provided by{" "}
            <a
              href="https://back-on-track.eu"
              target="_blank"
              rel="noopener noreferrer"
              className="!text-blue-900 underline hover:text-blue-700"
            >
              Back-on-Track.eu
            </a><br/><br/> Huge thanks to them!
          </p>
        </div>

        <div className="mt-6 text-right">
          <button
            onClick={() => setModalIsOpen(false)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition cursor-pointer"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}