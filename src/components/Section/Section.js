import { forwardRef } from 'react';

const Section = forwardRef(function Section(props, ref) {
  const { children, className, backgroundColor, ...rest } = props;

  return (
    <section ref={ref} className={className} data-background-color={backgroundColor} {...rest}>
      {children}
    </section>
  );
});

export default Section;
