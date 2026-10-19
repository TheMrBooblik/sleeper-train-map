import Link from "../Link";

const Button = ({children, href, className, ...rest}) => {
  const buttonClassName = `inline-flex justify-center items-center text-white text-base font-bold font-inherit uppercase text-center no-underline bg-[#5fbb9d] px-[1.4em] py-4 border-0 rounded-[0.2em] cursor-pointer transition-colors hover:bg-[#7fd4b4] disabled:text-white/50 disabled:bg-[#7fd4b4] disabled:cursor-default disabled:opacity-60 ${className || ''}`;

  const buttonProps = {
    className: buttonClassName,
    ...rest,
  };

  if (href) {
    if ( href.startsWith('/') ) {
      return (
        <Link href={href} {...buttonProps}>
          {children}
        </Link>
      );
    }
    return (
      <a href={href} {...buttonProps}>
        {children}
      </a>
    );
  }

  return (
    <button {...buttonProps}>
      {children}
    </button>
  );
};

export default Button;
