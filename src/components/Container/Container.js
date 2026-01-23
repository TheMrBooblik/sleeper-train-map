const Container = ({ children, className, ...rest }) => {
  const containerClassName = `w-full h-full mx-auto [&>h2:first-child]:mt-0 [&>h3:first-child]:mt-0 [&>h4:first-child]:mt-0 [&>p:first-child]:mt-0 [&>ul:first-child]:mt-0 [&>h2:last-child]:mb-0 [&>h3:last-child]:mb-0 [&>h4:last-child]:mb-0 [&>p:last-child]:mb-0 [&>ul:last-child]:mb-0 ${className || ''}`;

  return (
    <div className={containerClassName} {...rest}>
      {children}
    </div>
  );
};

export default Container;
